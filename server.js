const express = require("express");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const NodeCache = require("node-cache");

const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUR = "\x1b[33m";
const MEGENTA = "\x1b[33m";
const _END = "\x1b[0m";

const app = express();
app.use(express.json());
const server = http.createServer(app);
const cache = new NodeCache({
  stdTTL: 60 * 60, // Cache TTL of 1 hour
});

app.get("/", async (_, res) => {
  console.log("listen from screen share");
  return res
    .status(200)
    .json({ message: "Welcome to screen share server root endpoint" });
});

app.use(
  cors({
    origin: [
      "https://screen-sharing-platform.vercel.app",
      "http://localhost:3000",
      "http://localhost:5173",
    ],
  })
);

const io = socketIo(server, {
  cors: {
    origin: [
      "https://screen-sharing-platform.vercel.app",
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000, // 60 seconds
  pingInterval: 25000, // 25 seconds
  connectTimeout: 45000, // 45 seconds
});

const PORT = process.env.PORT || 5056;

// Store room data: { roomId: { sharerId: 'socketId', viewers: ['socketId1', 'socketId2'] } }
// Added a set to handle viewers for better performance on add/remove and uniqueness
const rooms = {};
cache.on("del", function (key, value) {
  console.log(`${RED}Cache entry deleted: ${key} with value ${value} ${_END}`);
});

io.on("connection", (socket) => {
  // set socketid to the cash
  const users = cache.get("active_users");
  let cacheRoom;
  if (!cache.has(socket.id)) {
    users
      ? cache.set("active_users", [...users, socket.id])
      : cache.set("active_users", [socket.id]);
  }
  emitActiveUser();
  // Handle joining a room
  socket.on("joinRoom", (roomId) => {
    // using node-cache
    if (socket.currentRoomId) {
      socket.leave(socket.currentRoomId);
      console.log(
        `User ${socket.id} left previous room: ${socket.currentRoomId}`
      );
      // Clean up old cacheRoom if needed, similar to disconnect
      cacheRoom = cache.get(socket.currentRoomId);
      if (cacheRoom) {
        // remove the remove from the old array
        cacheRoom.viewers = cacheRoom.viewers.filter((id) => id !== socket.id);

        // make null sharer id who was sharing her screen on this room
        if (cacheRoom.sharerId === socket.id) {
          cacheRoom.sharerId = null;
        }
        // if viewer is 0 and there are no sharer id then we can remove that room from our socket and cache
        if (cacheRoom.viewers.length === 0 && cacheRoom.sharerId === null) {
          cache.del(currentRoomId); // delete form cache
          console.log(
            `Room ${socket.currentRoomId} is now empty and deleted from our cache.`
          );
        }
      }
    }
    // TODO: remove this in future
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
    // TODO: here also we have to store the user name
    cacheRoom = cache.get(roomId);
    // try to find room using roomid in our cache
    if (!cacheRoom) {
      // if not in our cache then create it
      cache.set(roomId, {
        sharerId: null,
        viewers: [],
      });
    }
    // TODO: need to be remove this object assignment
    if (!rooms[roomId]) {
      rooms[roomId] = { sharerId: null, viewers: new Set() }; // Use Set for viewers
    }

    // Add user to the viewers list (everyone is a potential viewer initially)
    cacheRoom = cache.get(roomId);
    cache.set(roomId, {
      ...cacheRoom,
      viewers: [...cacheRoom.viewers, socket.id],
    });
    rooms[roomId].viewers.add(socket.id); // TODO: need to remove this object defining

    console.log(`User ${socket.id} joined room: ${roomId}`);
    console.log(
      `Current room state for ${roomId}: Sharer: ${
        rooms[roomId].sharerId
      }, Viewers: [${Array.from(rooms[roomId].viewers).join(", ")}]`
    );
    cacheRoom = cache.get(roomId);
    console.log(
      `${YELLOW}CACHE: Current room state for ${roomId}: Sharer: ${
        cacheRoom.sharerId
      }, Viewers: [${Array.from(cacheRoom.viewers).join(", ")}] ${_END}`
    );

    // If there's an active sharer, notify the new user about the sharer
    cacheRoom = cache.get(roomId);
    if (cacheRoom.sharerId && cacheRoom.sharerId !== socket.id) {
      // if it's true that means someone is sharing their screen
      socket.emit("sharerAvailable", cacheRoom.sharerId); // emit the event sharer is avaiabe with who share i mean the sharer id

      console.log(
        `${YELLOW}CACHE: Notified ${socket.id} about existing sharer ${cacheRoom.sharerId}${_END}`
      );
    }
    // TODO: this need to be remove
    if (rooms[roomId].sharerId && rooms[roomId].sharerId !== socket.id) {
      socket.emit("sharerAvailable", rooms[roomId].sharerId);
      console.log(
        `Notified ${socket.id} about existing sharer ${rooms[roomId].sharerId}`
      );
    }

    // Notify the sharer (if exists) that a new viewer has joined
    // This is crucial for the sharer to create a PC for the new viewer
    cacheRoom = cache.get(roomId);
    if (cacheRoom.sharerId && cacheRoom.sharerId !== socket.id) {
      io.to(cacheRoom.sharerId).emit("viewerJoined", socket.id);

      console.log(
        `${YELLOW}CACHE: Notified sharer ${rooms[roomId].sharerId} that viewer ${socket.id} joined ${_END}`
      );
    }
    // TODO: need to be remove
    if (rooms[roomId].sharerId && rooms[roomId].sharerId !== socket.id) {
      io.to(rooms[roomId].sharerId).emit("viewerJoined", socket.id);
      console.log(
        `Notified sharer ${rooms[roomId].sharerId} that viewer ${socket.id} joined`
      );
    }
  });

  // Handle starting screen share
  socket.on("startSharing", (roomId) => {
    let cacheRoom = cache.get(roomId);

    // initialize the room id
    // if (!cacheRoom) {
    //   cache.set(roomId, {
    //     sharerId: null,
    //     viewers: [],
    //   });
    // }
    if (!rooms[roomId]) {
      rooms[roomId] = { sharerId: null, viewers: new Set() };
    }

    console.log(`${MEGENTA}start sharing ${cacheRoom}${_END}`);
    if (cacheRoom.sharerId && cacheRoom.sharerId !== socket.id) {
      socket.emit("sharingConflict", cacheRoom.sharerId);
      console.log(
        `${MEGENTA}Sharing conflict for ${socket.id}. ${cacheRoom.sharerId} is already sharing.${_END}`
      );
      return;
    }
    // TODO: need remove
    // If someone else is already sharing, don't allow another sharer
    if (rooms[roomId].sharerId && rooms[roomId].sharerId !== socket.id) {
      socket.emit("sharingConflict", rooms[roomId].sharerId);
      console.log(
        `Sharing conflict for ${socket.id}. ${rooms[roomId].sharerId} is already sharing.`
      );
      return;
    }

    // TODO: nee dot remove
    rooms[roomId].sharerId = socket.id;
    console.log(`User ${socket.id} is now sharing in room: ${roomId}`);

    // Remove sharer from viewers set
    // If the room's sharerId is currently null, or if this socket is already the sharer
    cache.set(roomId, {
      sharerId: socket.id,
      viewers: [cacheRoom.viewers.filter((id) => id !== socket.id)],
    });
    // TODO: need to remove
    rooms[roomId].viewers.delete(socket.id);

    // Notify all *other* clients in the room about the new sharer
    socket.to(roomId).emit("sharerStarted", socket.id);
    console.log(
      `Broadcasted 'sharerStarted' for ${socket.id} in room ${roomId}`
    );
  });

  // Handle stopping screen share
  socket.on("stopSharing", (roomId) => {
    let cacheRoom = cache.get(roomId);
    if (cacheRoom && cacheRoom.sharerId === socket.id) {
      cache.set(roomId, {
        sharerId: null,
        viewers: cacheRoom.viewers.filter((id) => id !== socket.id),
      });
    }
    // TODO: need to remove
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
    // console.log(
    //   `Offer from ${socket.id} to ${data.targetSocketId} in room ${data.roomName}`
    // );
    // Directly forward to the target, no role-based checks here
    io.to(data.targetSocketId).emit("offer", {
      offer: data.offer,
      senderId: socket.id,
    });
  });

  // Handle WebRTC answer (can be from viewer to sharer, or sharer to viewer)
  socket.on("answer", (data) => {
    // console.log(
    //   `Answer from ${socket.id} to ${data.targetSocketId} in room ${data.roomName}`
    // );
    // Directly forward to the target, no role-based checks here
    io.to(data.targetSocketId).emit("answer", {
      answer: data.answer,
      senderId: socket.id,
    });
  });

  // Handle ICE candidates (bidirectional)
  socket.on("iceCandidate", (data) => {
    // console.log(
    //   `ICE Candidate from ${socket.id} to ${data.targetSocketId} in room ${data.roomName}`
    // );
    // Directly forward to the target
    io.to(data.targetSocketId).emit("iceCandidate", {
      candidate: data.candidate,
      senderId: socket.id,
    });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
    // when a user leave then we have to remove that user socketid from our cache
    const connectedUsers = cache.get("active_users");
    if (connectedUsers) {
      cache.set(
        "active_users",
        connectedUsers.filter((user) => user !== socket.id)
      );
    }
    emitActiveUser();

    const roomId = socket.currentRoomId; // Get the room ID stored on the socket
    let cacheRoom = null;

    if (roomId) {
      cacheRoom = cache.get(roomId);
      if (cacheRoom) {
        // Remove from viewers list
        cache.set(roomId, {
          ...cacheRoom,
          viewers: cacheRoom?.viewers?.filter((id) => id !== socket.id),
        });

        // If the disconnected user was the sharer, clear sharerId
        if (cache.sharerId === socket.id) {
          cache.set(roomId, {
            ...cacheRoom,
            sharerId: null,
          });
          console.log(
            `Sharer ${socket.id} disconnected from room ${roomId}. Sharer cleared.`
          );
          // Notify others in the room that sharer disconnected
          socket.to(roomId).emit("sharerStopped", socket.id);
        }
        // Clean up room if empty
        if (cacheRoom.viewers.length === 0 && cacheRoom.sharerId === null) {
          cache.del(roomId);
          console.log(`${RED}Room ${roomId} is now empty and deleted.${_END}`);
        }
        console.log(
          `${RED}Current room state after disconnect for room ${roomId}: Sharer: ${
            cacheRoom.sharerId
          }, Viewers: [${
            cacheRoom ? Array.from(cacheRoom.viewers).join(", ") : "N/A"
          }]${_END}`
        );
      }
    }
    // TODO: need to remove
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

function emitActiveUser() {
  const activeUsers = cache.get("active_users");
  io.emit("active_users", activeUsers);
}

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});
