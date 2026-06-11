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

// Lobby registry: roomId -> { roomId, hostId, hostName, deckClass, isPrivate,
// createdAt }. Drives the Home-page "active games" board. Live player counts are
// derived from getConnectedCount(roomId) (the Socket.IO room membership) rather
// than stored here, so the count can never drift from reality. Entries are
// removed when a room fills (game starts), empties, or its host disconnects.
const lobbyRooms = new Map();

// Socket.IO room used as a pub/sub channel for Home-page clients that want live
// updates of the open-games list. Sockets join it on `lobby_join` and leave it
// when they enter a game (`lobby_leave`) or disconnect.
const LOBBY_CHANNEL = "lobby";

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
  lobbyRooms.delete(roomId);
}

// Build the list of joinable public rooms: public, and currently holding exactly
// one connected player (1/2 — open for an opponent). A 0/2 room (host dropped,
// awaiting eviction) or a full 2/2 room (game underway) is excluded.
function buildRoomList() {
  const list = [];
  for (const [roomId, meta] of lobbyRooms) {
    if (meta.isPrivate) continue;
    if (getConnectedCount(roomId) !== 1) continue;
    list.push({
      roomId,
      hostName: meta.hostName,
      deckClass: meta.deckClass,
      players: 1,
      createdAt: meta.createdAt,
    });
  }
  // Newest rooms first.
  list.sort((a, b) => b.createdAt - a.createdAt);
  return list;
}

function broadcastRooms() {
  io.to(LOBBY_CHANNEL).emit("rooms_update", buildRoomList());
}

// Push the current connected-client count to everyone so each client's
// "users online" updates live as players join/leave (not just on their own
// connect). Deferred to a later tick by callers on disconnect, since the
// engine decrements its count around the same time the disconnect fires.
function broadcastUserCount() {
  io.emit("active_users", io.engine.clientsCount);
}

// Enforce one open room per host. Before a socket creates a new room, tear down
// any other room it still hosts (e.g. spamming PLAY) so stale "ghost" games
// don't pile up on the board.
function removeHostedRooms(socket, exceptRoomId) {
  for (const [roomId, meta] of lobbyRooms) {
    if (meta.hostId === socket.id && roomId !== exceptRoomId) {
      lobbyRooms.delete(roomId);
      socket.leave(roomId);
      const r = io.sockets.adapter.rooms.get(roomId);
      if (!r || r.size === 0) cleanupRoom(roomId);
    }
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
  // Tell everyone (not just the new socket) so existing clients' counts update.
  broadcastUserCount();

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
  // Home-page clients subscribe to the live open-games list. Send the current
  // snapshot immediately so the board is populated without waiting for the next
  // create/join/leave event.
  socket.on("lobby_join", () => {
    socket.join(LOBBY_CHANNEL);
    socket.emit("rooms_update", buildRoomList());
  });

  socket.on("lobby_leave", () => {
    socket.leave(LOBBY_CHANNEL);
  });

  socket.on("request_rooms", () => {
    socket.emit("rooms_update", buildRoomList());
  });

  // Private reconnect probe. A client that remembers a room (sessionStorage)
  // asks whether it can still rejoin it. We answer only to that socket — this is
  // never broadcast, so an in-progress game is offered for reconnect solely to
  // the player who left it. `isMember` lets the client distinguish a room it's
  // already in (its own open lobby room) from one it dropped out of and should
  // offer to reconnect to.
  socket.on("check_room", ({ room }) => {
    if (!room) return;
    const r = io.sockets.adapter.rooms.get(room);
    socket.emit("room_status", {
      room,
      connected: getConnectedCount(room),
      isMember: !!(r && r.has(socket.id)),
    });
  });

  // Host flips their room between public (listed) and private (hidden from the
  // board; only the host's own client shows it). Guarded so only the host can
  // change their own room.
  socket.on("set_room_privacy", ({ roomId, isPrivate }) => {
    const meta = lobbyRooms.get(roomId);
    if (meta && meta.hostId === socket.id) {
      meta.isPrivate = !!isPrivate;
      broadcastRooms();
    }
  });

  socket.on("create_room", (data) => {
    // Back-compat: older callers pass the room id as a bare string. The lobby
    // board passes { roomId, hostName, deckClass, isPrivate }.
    const roomId = typeof data === "string" ? data : data?.roomId;
    if (!roomId) return;
    const meta = typeof data === "string" ? {} : data || {};

    console.log(`[create_room] ${socket.id} room=${roomId} private=${!!meta.isPrivate}`);
    // A player can only host one room at a time — close any previous one.
    removeHostedRooms(socket, roomId);
    socket.join(roomId);
    socketRoomMap.set(socket.id, roomId);

    lobbyRooms.set(roomId, {
      roomId,
      hostId: socket.id,
      hostName: meta.hostName || "Anonymous",
      deckClass: meta.deckClass || "",
      isPrivate: !!meta.isPrivate,
      createdAt: Date.now(),
    });

    const room = io.sockets.adapter.rooms.get(roomId);
    console.log("Number of clients:", room ? room.size : 0);
    broadcastRooms();
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
      // Room is now 2/2 and the game is starting — pull it from the open-games
      // board so no third player can try to join.
      lobbyRooms.delete(data);
      broadcastRooms();
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
    lobbyRooms.delete(data);
    broadcastRooms();
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
    // The socket is gone, so any room it hosted now reads as 0/2 and drops out
    // of buildRoomList(). Refresh the board immediately; the registry entry is
    // purged below once the eviction grace period elapses.
    broadcastRooms();
    // Defer the count broadcast so the engine has decremented clientsCount.
    setTimeout(broadcastUserCount, 0);

    const timer = setTimeout(() => {
      evictStaleSocket(socket.id);
      evictionTimers.delete(socket.id);
      senderSeqCounters.delete(socket.id);
      socketRoomMap.delete(socket.id);
      broadcastRooms();
    }, EVICTION_GRACE_MS);
    evictionTimers.set(socket.id, timer);
  });
});

server.listen(PORT, () => {
  console.log(`Server has started on port ${PORT}`);
});
