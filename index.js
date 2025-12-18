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
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  },
});

// Store sequence numbers per room to ensure message ordering
const roomSequences = new Map();

// Get or create sequence number for a room
function getNextSequence(room) {
  if (!roomSequences.has(room)) {
    roomSequences.set(room, 0);
  }
  const current = roomSequences.get(room);
  roomSequences.set(room, current + 1);
  return current;
}

// Clean up sequence numbers when room is empty
function cleanupRoomSequence(room) {
  const roomSockets = io.sockets.adapter.rooms.get(room);
  if (!roomSockets || roomSockets.size === 0) {
    roomSequences.delete(room);
  }
}

app.get("/", (req, res) => {
  res.send(`<h1>Socket IO Start on Port: ${PORT}</h1>`);
});

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);
  console.log(socket.client.conn.server.clientsCount + " users connected");
  socket.emit("active_users", socket.client.conn.server.clientsCount);

  // Notify other players in rooms that this user is online
  for (const room of socket.rooms) {
    if (room !== socket.id) {
      socket.to(room).emit("online", socket.id);
    }
  }

  socket.on("create_room", (data) => {
    console.log(`User ${socket.id} creating room: ${data}`);
    socket.join(data);
    let room = io.sockets.adapter.rooms.get(data);
    console.log("Number of clients:", room.size);
    // Initialize sequence for new room
    if (!roomSequences.has(data)) {
      roomSequences.set(data, 0);
    }
  });

  socket.on("join_room", (data) => {
    console.log(`User ${socket.id} joining room: ${data}`);
    let room = io.sockets.adapter.rooms.get(data);
    if (room && room.size === 1) {
      socket.join(data);
      console.log("Number of clients: 2");
      io.in(data).emit("start_game");
      // Initialize sequence if not exists
      if (!roomSequences.has(data)) {
        roomSequences.set(data, 0);
      }
    } else if (room && room.size === 2) {
      console.log("Room is full 2/2");
    } else {
      console.log("No room available");
    }
  });

  socket.on("leave_room", (data) => {
    socket.leave(data);
    console.log(`User ${socket.id} leaving room: ${data}`);
    cleanupRoomSequence(data);
  });

  socket.on("send msg", (data) => {
    if (!data.room) {
      console.warn(`Message from ${socket.id} missing room:`, data);
      return;
    }

    // Verify sender is in the room
    const room = io.sockets.adapter.rooms.get(data.room);
    if (!room || !room.has(socket.id)) {
      console.warn(`User ${socket.id} not in room ${data.room}`);
      return;
    }

    // Add sequence number and timestamp to ensure ordering
    const sequence = getNextSequence(data.room);
    const timestamp = Date.now();

    // Prepare the message with metadata
    const message = {
      ...data,
      sequence,
      timestamp,
    };

    // If data already has updates array, use it; otherwise wrap single update
    if (!message.updates && message.type) {
      // Convert single update to updates array format for consistency
      message.updates = [
        {
          type: message.type,
          data: message.data,
        },
      ];
      // Keep original fields for backward compatibility
    }

    // Send to other players in the room
    socket.to(data.room).emit("receive msg", message);

    console.log(`Message sent to room ${data.room} with sequence ${sequence}`);
  });

  socket.on("request_state", ({ room }) => {
    if (!room) {
      console.warn(`State request from ${socket.id} missing room`);
      return;
    }

    // Verify requester is in the room
    const roomSockets = io.sockets.adapter.rooms.get(room);
    if (!roomSockets || !roomSockets.has(socket.id)) {
      console.warn(`User ${socket.id} not in room ${room} for state request`);
      return;
    }

    // Relay the request to the other player
    socket.to(room).emit("send_full_state", { requesterId: socket.id });
    console.log(`State request relayed for room ${room}`);
  });

  socket.on("send_full_state", ({ requesterId, fullState }) => {
    if (!requesterId || !fullState) {
      console.warn(`Invalid full state from ${socket.id}`);
      return;
    }

    // Send full state with a special sequence to indicate it's a state sync
    const message = {
      type: "full_state_sync",
      data: fullState,
      sequence: -1, // Special sequence for state syncs
      timestamp: Date.now(),
    };

    io.to(requesterId).emit("receive_full_state", message);
    console.log(`Full state sent to ${requesterId}`);
  });

  socket.on("disconnecting", (reason) => {
    console.log(`User ${socket.id} disconnecting: ${reason}`);
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit("offline", socket.id);
        cleanupRoomSequence(room);
      }
    }
  });

  socket.on("disconnect", (reason) => {
    console.log(`User Disconnected: ${socket.id}, reason: ${reason}`);

    // Clean up any rooms this user was in
    // Note: socket.rooms is not available in disconnect, so we track it differently
    // The cleanup happens in disconnecting event
  });
});

// Periodic cleanup of empty rooms
setInterval(() => {
  const rooms = Array.from(roomSequences.keys());
  for (const room of rooms) {
    const roomSockets = io.sockets.adapter.rooms.get(room);
    if (!roomSockets || roomSockets.size === 0) {
      roomSequences.delete(room);
      console.log(`Cleaned up sequence for empty room: ${room}`);
    }
  }
}, 60000); // Clean up every minute

server.listen(PORT, () => {
  console.log(`Server has started on port ${PORT}`);
});
