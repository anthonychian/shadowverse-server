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
      "http://localhost:3000",
      "http://127.0.0.1:3000",
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

// Per-sender outgoing sequence counter: socketId -> n.
// Each client only ever receives its opponent's messages, so a per-sender
// counter gives the receiver a contiguous, gap-detectable stream. The client
// uses gaps (and counter resets, e.g. after a server restart) to trigger a
// full-state resync instead of silently diverging.
const senderSeqCounters = new Map();

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
        // Pull a fresh, authoritative copy of the opponent's live state.
        // (Any deltas missed during the disconnect are reconciled here.)
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
    // Re-add the socket whenever it isn't already a member — INCLUDING when the
    // room no longer exists (server restart, or both players had dropped so the
    // room was emptied). In that case socket.join recreates it. The previous
    // `if (room && ...)` guard silently no-opped a reconnect into an empty room,
    // orphaning the socket: it was never put back in the room and never got a
    // state resync, so the reconnect "didn't work" and the desync persisted.
    if (!room || !room.has(socket.id)) {
      socket.join(data);
      socketRoomMap.set(socket.id, data);
      socket.to(data).emit("online", socket.id);
      console.log(
        `[rejoin_room] ${socket.id} rejoined ${data} (${getConnectedCount(data)} clients)`,
      );
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
    // Per-sender sequence number. The receiver only ever sees this socket's
    // stream, so the numbers are contiguous and any gap (or a reset back toward
    // 1 after a server restart / socket reuse) is detectable client-side and
    // triggers a full-state resync. `_from` lets the client key the counter per
    // opponent and resync when the opponent reconnects with a new socket id.
    const seq = (senderSeqCounters.get(socket.id) || 0) + 1;
    senderSeqCounters.set(socket.id, seq);
    socket
      .to(data.room)
      .emit("receive msg", { ...data, _seq: seq, _from: socket.id });
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
      senderSeqCounters.delete(socket.id);
      socketRoomMap.delete(socket.id);
    }, EVICTION_GRACE_MS);
    evictionTimers.set(socket.id, timer);
  });
});

server.listen(PORT, () => {
  console.log(`Server has started on port ${PORT}`);
});
