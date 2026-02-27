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
    origin: "https://sveclient.vercel.app/",
    methods: ["GET", "POST"],
    transports: ["websocket"],
    credentials: true,
  },
  allowEIO3: true,
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingInterval: 5000,
  pingTimeout: 10000,
});

// In-memory state store: roomId -> { socketId: cardState, ... }
const roomStates = new Map();

app.get("/", (req, res) => {
  res.send(`<h1>Socket IO Start on Port: ${PORT}</h1>`);
});

io.on("connection", (socket) => {
  const userCount = socket.client.conn.server.clientsCount;
  console.log(
    `User Connected: ${socket.id} (recovered: ${socket.recovered}) | ${userCount} users`,
  );
  socket.emit("active_users", userCount);

  if (socket.recovered) {
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit("send_full_state", { requesterId: socket.id });
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
    let room = io.sockets.adapter.rooms.get(data);
    console.log("Number of clients:", room.size);
  });

  socket.on("join_room", (data) => {
    console.log(data);
    let room = io.sockets.adapter.rooms.get(data);
    if (room && room.size === 1) {
      socket.join(data);
      console.log("Number of clients: 2");
      socket.to(data).emit("online", socket.id);
      io.in(data).emit("start_game");
    } else if (room && room.size === 2) {
      console.log("Room is full 2/2");
    } else {
      console.log("No room available");
    }
  });

  socket.on("rejoin_room", (data) => {
    const room = io.sockets.adapter.rooms.get(data);
    if (room && !room.has(socket.id)) {
      socket.join(data);
      socket.to(data).emit("online", socket.id);
      console.log(
        `[rejoin_room] ${socket.id} rejoined ${data} (${room.size} clients)`,
      );
    }
  });

  socket.on("leave_room", (data) => {
    socket.leave(data);
    console.log(`Leaving room: ${data}`);
  });

  socket.on("send msg", (data) => {
    socket.to(data.room).emit("receive msg", data);
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
    console.log(`User Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server has started on port ${PORT}`);
});
