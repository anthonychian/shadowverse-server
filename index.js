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
    origin: "https://shadowverse-client.vercel.app/",
    methods: ["GET", "POST"],
    transports: ["websocket"],
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
    console.log("Number of clients", io.sockets.clients(room));
    socket.join(data);
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
