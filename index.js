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
  connectionStateRecovery: {},
});

app.get("/", (req, res) => {
  res.send(`<h1>Socket IO Start on Port: ${PORT}</h1>`);
});

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);
  console.log(socket.client.conn.server.clientsCount + " users connected");
  socket.emit("active_users", socket.client.conn.server.clientsCount);
  for (const room of socket.rooms) {
    if (room !== socket.id) {
      socket.to(room).emit("online", socket.id);
    }
  }
  socket.on("create_room", (data) => {
    console.log(`Socket ${socket.id} creating room: ${data}`);
    socket.join(data);
    let room = io.sockets.adapter.rooms.get(data);
    console.log("Number of clients:", room.size);
    socket.emit("room_created", { room: data, waiting: true });
  });

  socket.on("join_room", (data) => {
    console.log(`Socket ${socket.id} attempting to join room: ${data}`);
    let room = io.sockets.adapter.rooms.get(data);
    if (room && room.size === 1) {
      socket.join(data);
      console.log("Number of clients: 2");
      // Notify both clients that the game can start
      io.in(data).emit("start_game", { room: data });
      // Notify the room creator that someone joined
      socket.to(data).emit("player_joined", { playerId: socket.id });
      // Confirm to the joiner
      socket.emit("room_joined", { room: data, success: true });
    } else if (room && room.size === 2) {
      console.log("Room is full 2/2");
      socket.emit("room_full", { room: data });
    } else {
      console.log("No room available");
      socket.emit("room_not_found", { room: data });
    }
  });

  socket.on("leave_room", (data) => {
    socket.leave(data);
    console.log(`Leaving room: ${data}`);
  });

  socket.on("send msg", (data) => {
    console.log(`Message from ${socket.id} to room ${data.room}:`, data);
    socket.to(data.room).emit("receive msg", data);
  });

  socket.on("request_state", ({ room }) => {
    console.log(`State request from ${socket.id} in room ${room}`);
    // Relay the request to the other player
    socket.to(room).emit("send_full_state", { requesterId: socket.id });
  });

  socket.on("send_full_state", ({ requesterId, fullState, room }) => {
    console.log(`Full state sent to ${requesterId} in room ${room}`);
    io.to(requesterId).emit("receive_full_state", fullState);
  });

  // Generic game action relay - broadcasts any game event to the room
  socket.on("game_action", (data) => {
    console.log(`Game action from ${socket.id}:`, data);
    if (data.room) {
      socket.to(data.room).emit("game_action", {
        ...data,
        fromPlayer: socket.id,
      });
    } else {
      console.warn(`Game action from ${socket.id} missing room info`);
    }
  });

  // Relay any event that includes a room property
  socket.onAny((eventName, data) => {
    // Skip internal socket.io events and events we've already handled
    if (
      eventName.startsWith("_") ||
      [
        "connection",
        "disconnect",
        "disconnecting",
        "create_room",
        "join_room",
        "leave_room",
        "send msg",
        "request_state",
        "send_full_state",
        "game_action",
      ].includes(eventName)
    ) {
      return;
    }

    // If the event has a room property, relay it to other clients in that room
    if (data && typeof data === "object" && data.room) {
      console.log(
        `Relaying event "${eventName}" from ${socket.id} to room ${data.room}`
      );
      socket.to(data.room).emit(eventName, {
        ...data,
        fromPlayer: socket.id,
      });
    }
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
