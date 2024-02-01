const express = require("express");
const app = express();
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

app.use(cors());

const PORT = process.env.PORT || 8000;

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    // origin: "http://localhost:3000",
    origin: "https://shadowverse-client.vercel.app",
    methods: ["GET", "POST"],
    transports: ["websocket", "polling"],
    credentials: true,
  },
  allowEIO3: true,
});

app.get("/", (req, res) => {
  res.send(`<h1>Socket IO Start on Port: ${PORT}</h1>`);
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
