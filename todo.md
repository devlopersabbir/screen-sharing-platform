## Joining to the Room (EVENT: **joinRoom**)

- [x] If socket has currentRoomId object then we have to leave / remove from the previous room and also we have to remove that room from the cache
- [x] Simply socket join with the roomId (**which will comes from front-end**)
  - Secondly once join we have to set the roomId to the currentRoomId as socket object
  - Letter we can access it like `socket.currentRoomId` which is gives us the currentRoomId
- [x] Set the cache with key of `roomId` and the value is

```js
cache.set(roomId, {
  sharerId: null, // initially null
  viewers: [...previous_cache_room.viewers, socket.id], // if already has viewser then just make copy and add new socket id as viewser
});
```

- [x] if someone already sharing their screen on the job then and letter if someone join then we have to notify our new joined user about someone/current user is sharing their screen
  - So, that we fire `sharerAvailable` emit on the current room with the `sharerId` who is currently sharing their own screen
- [x] Again Notify the user who sharing that a new user is joined on this job
  - This is crucial for the sharer to create a PC for the new viewer.
  - `viewerJoined` event will emit to the sharerId (i mean who sharing)
  - so, it's looks like `io.to(sharerId).emit(viewerJoined, socket.id)`

## Start sharing Screen (EVENT: **startSharing**)

- [x] If someone else is already sharing, don't allow another sharer
  - Emit `sharingConflict` event with the sharerId to avoid conflict
- [x] If the room's sharerId is currently null, or if this socket is already the sharer
  - Then set the `socket.id` to the `sharerId` which is null in our cache
  - now remove that socket id from the viewer list who share screen
- [x] Notify all **other** clients in the room about the new sharer
  - Emit `sharerStarted` to the room with the referrance socket id
  - the code will be something like `socket.io(roomId).emit("sharerStarted", socket.id)`
  - This event will help to to broadcasted `sharerStarted` fro our socket in that room

## Stop sharing Screen (EVENT: **stopSharing**)

- [x] if roomId and sharerId match with the current socket id then make **sharerId is null**
- [x] Add the stopped sharer back to as viewers
- [x] Emit `sharerStopped` event to the room with the reffarance of socket id
  - the event should be worte like `socket.to(roomId).emit("sharerStopped", socket.id)`

## When a socket disconnect (EVENT: **disconnect**)

- [x]
