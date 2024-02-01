const express = require("express");
const app = express();
const https = require("https");
const { Server } = require("socket.io");
const cors = require("cors");

app.use(cors());

const PORT = process.env.PORT || 5000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    // origin: "http://localhost:3000",
    origin: "https://shadowverse-client.vercel.app/",
    methods: ["GET", "POST"],
    transports: ["websocket", "polling"],
  },
  allowEIO3: true,
});

io.on("connection", (socket) => {
  console.log(`User Connected: ${socket.id}`);

  socket.on("join_room", (data) => {
    socket.join(data);
  });

  socket.on("send msg", (data) => {
    socket.to(data.room).emit("receive msg", data);
  });
});

server.listen(PORT, () => {
  console.log(`Server has started on port ${PORT}`);
});
