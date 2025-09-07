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
    // origin: "http://localhost:3000",
    // origin: "https://shadowverse-client.vercel.app/",
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
      io.in(data).emit("start_game");
    } else if (room && room.size === 2) {
      console.log("Room is full 2/2");
    } else {
      console.log("No room available");
    }
  });

  socket.on("leave_room", (data) => {
    socket.leave(data);
    console.log(`Leaving room: ${data}`);
  });

  socket.on("send msg", (data) => {
    socket.to(data.room).emit("receive msg", data);
  });

  socket.on("disconnect", (reason) => {
    console.log(`User Disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server has started on port ${PORT}`);
});
