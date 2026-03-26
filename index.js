const express = require("express");
const app = express();
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

app.use(cors());

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      "https://sveclient.vercel.app",
      "https://sveclient.vercel.app/",
    ],
    methods: ["GET", "POST"],
    credentials: true,
  },
  allowEIO3: true,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingInterval: 5000,
  pingTimeout: 10000,
  maxHttpBufferSize: 1e6,
});

// In-memory state store: roomId -> { socketId: cardState, ... }
const roomStates = new Map();

// Pending eviction timers: socketId -> timeout handle
const evictionTimers = new Map();
const EVICTION_GRACE_MS = 15_000;

// Message buffer per room: roomId -> [{ seq, data, timestamp }]
const messageBuffers = new Map();
const MSG_BUFFER_SIZE = 100;
const MSG_BUFFER_TTL_MS = 60_000;

// Sequence counter per room
const roomSeqCounters = new Map();

// Track last received seq per socket for gap detection
const socketLastRecvSeq = new Map();

// Track which game room each socket is in (not counting the auto-room)
const socketRoomMap = new Map();

// Pending state-exchange retries: requesterId -> { timer, attempts, room }
const stateRequestRetries = new Map();
const STATE_REQUEST_TIMEOUT_MS = 5000;
const STATE_REQUEST_MAX_RETRIES = 3;

function getConnectedCount(roomId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return 0;
  let count = 0;
  for (const id of room) {
    if (io.sockets.sockets.has(id)) count++;
  }
  return count;
}

function evictStaleSocket(socketId) {
  for (const [roomId, members] of io.sockets.adapter.rooms) {
    if (roomId === socketId) continue;
    if (members.has(socketId) && !io.sockets.sockets.has(socketId)) {
      members.delete(socketId);
      console.log(
        `[evict] removed stale socket ${socketId} from room ${roomId}`,
      );
      if (members.size === 0) {
        io.sockets.adapter.rooms.delete(roomId);
        cleanupRoom(roomId);
      }
    }
  }
}

function cleanupRoom(roomId) {
  roomStates.delete(roomId);
  messageBuffers.delete(roomId);
  roomSeqCounters.delete(roomId);
}

function bufferMessage(room, data) {
  const seq = (roomSeqCounters.get(room) || 0) + 1;
  roomSeqCounters.set(room, seq);

  if (!messageBuffers.has(room)) messageBuffers.set(room, []);
  const buf = messageBuffers.get(room);
  buf.push({ seq, data, timestamp: Date.now() });
  if (buf.length > MSG_BUFFER_SIZE) buf.shift();

  const cutoff = Date.now() - MSG_BUFFER_TTL_MS;
  while (buf.length > 0 && buf[0].timestamp < cutoff) buf.shift();

  return seq;
}

function replayMissedMessages(socket, room) {
  const lastSeq = socketLastRecvSeq.get(socket.id) || 0;
  const buf = messageBuffers.get(room);
  if (!buf || buf.length === 0) return;

  const missed = buf.filter((m) => m.seq > lastSeq);
  if (missed.length > 0) {
    console.log(
      `[replay] sending ${missed.length} missed messages to ${socket.id} (last_seq=${lastSeq})`,
    );
    socket.emit("missed_messages", {
      messages: missed.map((m) => ({ ...m.data, _seq: m.seq })),
    });
  }
}

function requestStateWithRetry(socket, room) {
  cancelStateRetry(socket.id);

  let attempts = 0;
  function attempt() {
    attempts++;
    console.log(
      `[state_retry] attempt ${attempts}/${STATE_REQUEST_MAX_RETRIES} for ${socket.id} in room=${room}`,
    );
    socket.to(room).emit("send_full_state", { requesterId: socket.id });

    if (attempts < STATE_REQUEST_MAX_RETRIES) {
      const timer = setTimeout(attempt, STATE_REQUEST_TIMEOUT_MS);
      stateRequestRetries.set(socket.id, { timer, attempts, room });
    } else {
      stateRequestRetries.delete(socket.id);
    }
  }

  attempt();
}

function cancelStateRetry(socketId) {
  const pending = stateRequestRetries.get(socketId);
  if (pending) {
    clearTimeout(pending.timer);
    stateRequestRetries.delete(socketId);
  }
}

app.get("/", (req, res) => {
  res.send(`<h1>Socket IO Start on Port: ${PORT}</h1>`);
});

io.on("connection", (socket) => {
  if (evictionTimers.has(socket.id)) {
    clearTimeout(evictionTimers.get(socket.id));
    evictionTimers.delete(socket.id);
    console.log(`[evict] cancelled eviction for recovered socket ${socket.id}`);
  }

  const userCount = socket.client.conn.server.clientsCount;
  console.log(
    `User Connected: ${socket.id} (recovered: ${socket.recovered}) | ${userCount} users`,
  );
  socket.emit("active_users", userCount);

  if (socket.recovered) {
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socketRoomMap.set(socket.id, room);
        replayMissedMessages(socket, room);
        requestStateWithRetry(socket, room);
      }
    }
  } else {
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit("online", socket.id);
      }
    }
  }
  socket.on("create_room", (data) => {
    console.log(data);
    socket.join(data);
    socketRoomMap.set(socket.id, data);
    let room = io.sockets.adapter.rooms.get(data);
    console.log("Number of clients:", room.size);
  });

  socket.on("join_room", (data) => {
    console.log(data);
    const room = io.sockets.adapter.rooms.get(data);
    const connected = getConnectedCount(data);
    console.log(
      `[join_room] room=${data} raw_size=${room?.size ?? 0} connected=${connected}`,
    );
    if (room && connected < 2) {
      socket.join(data);
      socketRoomMap.set(socket.id, data);
      console.log("Number of clients:", getConnectedCount(data));
      socket.to(data).emit("online", socket.id);
      io.in(data).emit("start_game");
    } else if (room && connected >= 2) {
      console.log("Room is full 2/2");
    } else {
      console.log("No room available");
    }
  });

  socket.on("rejoin_room", (data) => {
    const room = io.sockets.adapter.rooms.get(data);
    if (room && !room.has(socket.id)) {
      socket.join(data);
      socketRoomMap.set(socket.id, data);
      socket.to(data).emit("online", socket.id);
      console.log(
        `[rejoin_room] ${socket.id} rejoined ${data} (${room.size} clients)`,
      );
      replayMissedMessages(socket, data);
      requestStateWithRetry(socket, data);
    }
  });

  socket.on("leave_room", (data) => {
    socket.leave(data);
    socketRoomMap.delete(socket.id);
    console.log(`Leaving room: ${data}`);
    const room = io.sockets.adapter.rooms.get(data);
    if (!room || room.size === 0) {
      cleanupRoom(data);
    }
  });

  socket.on("send msg", (data) => {
    const seq = bufferMessage(data.room, data);
    socketLastRecvSeq.set(socket.id, seq);
    socket.to(data.room).emit("receive msg", { ...data, _seq: seq });
  });

  socket.on("store_state", ({ room, playerId, state }) => {
    if (!room || !playerId) return;
    if (!roomStates.has(room)) {
      roomStates.set(room, {});
    }
    roomStates.get(room)[playerId] = state;
  });

  socket.on("request_stored_state", ({ room, playerId }) => {
    console.log(
      `[request_stored_state] socket=${socket.id} playerId=${playerId} room=${room}`,
    );
    const states = roomStates.get(room);
    if (!states) {
      console.log(`[request_stored_state] no stored state for room ${room}`);
      return;
    }

    const payload = {};
    if (states[playerId]) payload.ownState = states[playerId];
    const enemyEntry = Object.entries(states).find(([id]) => id !== playerId);
    if (enemyEntry) payload.enemyState = enemyEntry[1];

    console.log(
      `[request_stored_state] sending: ownState=${!!payload.ownState}, enemyState=${!!payload.enemyState}`,
    );
    socket.emit("receive_stored_state", payload);
  });

  socket.on("request_state", ({ room }) => {
    console.log(
      `[request_state] ${socket.id} requesting state from room=${room}`,
    );
    socket.to(room).emit("send_full_state", { requesterId: socket.id });
  });

  socket.on("send_full_state", ({ requesterId, fullState }) => {
    console.log(
      `[send_full_state] ${socket.id} responding with state for ${requesterId}, has data: ${!!fullState}`,
    );
    cancelStateRetry(requesterId);
    io.to(requesterId).emit("receive_full_state", fullState);
  });

  socket.on("disconnecting", (reason) => {
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit("offline", socket.id);
      }
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`User Disconnected: ${socket.id} (reason: ${reason})`);
    cancelStateRetry(socket.id);

    const timer = setTimeout(() => {
      evictStaleSocket(socket.id);
      evictionTimers.delete(socket.id);
      socketLastRecvSeq.delete(socket.id);
      socketRoomMap.delete(socket.id);
    }, EVICTION_GRACE_MS);
    evictionTimers.set(socket.id, timer);
  });
});

server.listen(PORT, () => {
  console.log(`Server has started on port ${PORT}`);
});
