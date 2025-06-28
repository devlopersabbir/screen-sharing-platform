const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
app.use(express.json());
const server = http.createServer(app);

app.get("/", async (_, res) => {
  return res
    .status(200)
    .json({ message: "Welcome to screen share server root endpoint" });
});
app.get("*", async (_, res) => {
  return res.status(200).json({
    message: "Welcome to screen share server root endpoint",
    path: "invalid path",
  });
});
const io = socketIo(server, {
  cors: {
    origin: "https://screen-sharing-platform.vercel.app",
    methods: ["GET", "POST"],
  },
});

app.use(cors());

const PORT = process.env.PORT || 5000;

// Store room data: { roomId: { sharerId: 'socketId', viewers: ['socketId1', 'socketId2'] } }
// Added a set to handle viewers for better performance on add/remove and uniqueness
const rooms = {};

io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  // Handle joining a room
  socket.on("joinRoom", (roomId) => {
    // Leave any previously joined room
    if (socket.currentRoomId) {
      socket.leave(socket.currentRoomId);
      console.log(
        `User ${socket.id} left previous room: ${socket.currentRoomId}`
      );
      // Clean up old room state if needed, similar to disconnect
      if (rooms[socket.currentRoomId]) {
        rooms[socket.currentRoomId].viewers = rooms[
          socket.currentRoomId
        ].viewers.filter((id) => id !== socket.id);
        if (rooms[socket.currentRoomId].sharerId === socket.id) {
          rooms[socket.currentRoomId].sharerId = null;
        }
        if (
          rooms[socket.currentRoomId].viewers.length === 0 &&
          rooms[socket.currentRoomId].sharerId === null
        ) {
          delete rooms[socket.currentRoomId];
          console.log(`Room ${socket.currentRoomId} is now empty and deleted.`);
        }
      }
    }

    socket.join(roomId);
    socket.currentRoomId = roomId; // Store the room ID on the socket object for easier access

    if (!rooms[roomId]) {
      rooms[roomId] = { sharerId: null, viewers: new Set() }; // Use Set for viewers
    }

    // Add user to the viewers list (everyone is a potential viewer initially)
    rooms[roomId].viewers.add(socket.id);

    console.log(`User ${socket.id} joined room: ${roomId}`);
    console.log(
      `Current room state for ${roomId}: Sharer: ${
        rooms[roomId].sharerId
      }, Viewers: [${Array.from(rooms[roomId].viewers).join(", ")}]`
    );

    // If there's an active sharer, notify the new user about the sharer
    if (rooms[roomId].sharerId && rooms[roomId].sharerId !== socket.id) {
      socket.emit("sharerAvailable", rooms[roomId].sharerId);
      console.log(
        `Notified ${socket.id} about existing sharer ${rooms[roomId].sharerId}`
      );
    }

    // Notify the sharer (if exists) that a new viewer has joined
    // This is crucial for the sharer to create a PC for the new viewer
    if (rooms[roomId].sharerId && rooms[roomId].sharerId !== socket.id) {
      io.to(rooms[roomId].sharerId).emit("viewerJoined", socket.id);
      console.log(
        `Notified sharer ${rooms[roomId].sharerId} that viewer ${socket.id} joined`
      );
    }
  });

  // Handle starting screen share
  socket.on("startSharing", (roomId) => {
    if (!rooms[roomId]) {
      rooms[roomId] = { sharerId: null, viewers: new Set() };
    }

    // If someone else is already sharing, don't allow another sharer
    if (rooms[roomId].sharerId && rooms[roomId].sharerId !== socket.id) {
      socket.emit("sharingConflict", rooms[roomId].sharerId);
      console.log(
        `Sharing conflict for ${socket.id}. ${rooms[roomId].sharerId} is already sharing.`
      );
      return;
    }

    // If the room's sharerId is currently null, or if this socket is already the sharer
    rooms[roomId].sharerId = socket.id;
    console.log(`User ${socket.id} is now sharing in room: ${roomId}`);

    // Remove sharer from viewers set
    rooms[roomId].viewers.delete(socket.id);

    // Notify all *other* clients in the room about the new sharer
    socket.to(roomId).emit("sharerStarted", socket.id);
    console.log(
      `Broadcasted 'sharerStarted' for ${socket.id} in room ${roomId}`
    );
  });

  // Handle stopping screen share
  socket.on("stopSharing", (roomId) => {
    if (rooms[roomId] && rooms[roomId].sharerId === socket.id) {
      rooms[roomId].sharerId = null;
      // Add the stopped sharer back to viewers set
      rooms[roomId].viewers.add(socket.id); // No need to check for duplicates with Set

      console.log(`User ${socket.id} stopped sharing in room: ${roomId}`);
      socket.to(roomId).emit("sharerStopped", socket.id);
    }
  });

  // --- Universal WebRTC Signaling Relays ---

  // Handle WebRTC offer (can be from sharer to viewer, or viewer to sharer)
  socket.on("offer", (data) => {
    console.log(
      `Offer from ${socket.id} to ${data.targetSocketId} in room ${data.roomName}`
    );
    // Directly forward to the target, no role-based checks here
    io.to(data.targetSocketId).emit("offer", {
      offer: data.offer,
      senderId: socket.id,
    });
  });

  // Handle WebRTC answer (can be from viewer to sharer, or sharer to viewer)
  socket.on("answer", (data) => {
    console.log(
      `Answer from ${socket.id} to ${data.targetSocketId} in room ${data.roomName}`
    );
    // Directly forward to the target, no role-based checks here
    io.to(data.targetSocketId).emit("answer", {
      answer: data.answer,
      senderId: socket.id,
    });
  });

  // Handle ICE candidates (bidirectional)
  socket.on("iceCandidate", (data) => {
    console.log(
      `ICE Candidate from ${socket.id} to ${data.targetSocketId} in room ${data.roomName}`
    );
    // Directly forward to the target
    io.to(data.targetSocketId).emit("iceCandidate", {
      candidate: data.candidate,
      senderId: socket.id,
    });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    const roomId = socket.currentRoomId; // Get the room ID stored on the socket

    if (roomId && rooms[roomId]) {
      // Remove from viewers list
      rooms[roomId].viewers.delete(socket.id);

      // If the disconnected user was the sharer, clear sharerId
      if (rooms[roomId].sharerId === socket.id) {
        rooms[roomId].sharerId = null;
        console.log(
          `Sharer ${socket.id} disconnected from room ${roomId}. Sharer cleared.`
        );
        // Notify others in the room that sharer disconnected
        socket.to(roomId).emit("sharerStopped", socket.id);
      }

      // Clean up room if empty
      if (
        rooms[roomId].viewers.size === 0 && // Check size for Set
        rooms[roomId].sharerId === null
      ) {
        delete rooms[roomId];
        console.log(`Room ${roomId} is now empty and deleted.`);
      }
      console.log(
        `Current room state after disconnect for room ${roomId}: Sharer: ${
          rooms[roomId]?.sharerId
        }, Viewers: [${
          rooms[roomId] ? Array.from(rooms[roomId].viewers).join(", ") : "N/A"
        }]`
      );
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
