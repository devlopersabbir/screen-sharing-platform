import { useEffect, useRef, useState, useCallback } from "react";
import io, { Socket } from "socket.io-client";
import { startCapture } from "./utils";
import "webrtc-adapter";
import { baseUri } from "./constants";

const configuration: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }], // free google ice server
};

export default function App() {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const socket = useRef<Socket | null>(null);

  const [roomId, setRoomId] = useState<string>("");
  const [joinedRoom, setJoinedRoom] = useState<boolean>(false);
  const [isSharer, setIsSharer] = useState<boolean>(false);
  const [sharerId, setSharerId] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [statusMessage, setStatusMessage] = useState<string>(
    "Enter a room ID to join."
  );

  // Function to create or get a peer connection for a specific remote user
  const getOrCreatePeerConnection = useCallback(
    (remoteSocketId: string): RTCPeerConnection => {
      if (peerConnections.current.has(remoteSocketId)) {
        return peerConnections.current.get(remoteSocketId)!;
      }

      console.log(`Creating new RTCPeerConnection for ${remoteSocketId}`);
      const pc = new RTCPeerConnection(configuration);
      console.log(
        "PeerConnection signalingState (initial): ",
        pc.signalingState
      );

      // Add local stream tracks to the new peer connection if available
      // This is primarily for the sharer to add their screen stream to new viewers
      // NOTE: `localStream` here refers to the state variable.
      // If this function is called immediately after `setLocalStream(stream)`,
      // `localStream` might still be the old value.
      // For the sharer's initial setup, the tracks are added in shareScreenHandler.
      // For viewers joining *after* sharer has started, the sharer's `viewerJoined` handler
      // will explicitly add tracks using the `stream` variable (which is correct).
      // However, for completeness and robustness, keeping this logic here for cases
      // where `localStream` might be correctly set *before* creating a PC.
      if (localStream) {
        console.log(`Adding localStream tracks to PC for ${remoteSocketId}`);
        localStream.getTracks().forEach((track: MediaStreamTrack) => {
          pc.addTrack(track, localStream);
        });
      } else {
        console.log(
          "No localStream to add when creating PC for",
          remoteSocketId
        );
      }

      // Inside getOrCreatePeerConnection useCallback
      pc.ontrack = (event: RTCTrackEvent) => {
        console.log("RTCPeerConnection ontrack event fired!");
        console.log(
          "Remote track received:",
          event.streams[0],
          "from",
          remoteSocketId,
          "current sharerId (for debug):", // This log can stay to show the race
          sharerId,
          "is it the sharer's stream (for debug)?",
          remoteSocketId === sharerId
        );

        // If the current user is a viewer, they are expecting a stream.
        // The `remoteSocketId` here is the ID of the peer this particular
        // PeerConnection object is associated with.
        // Since a viewer only ever connects to the sharer to receive their stream,
        // this incoming track MUST be the sharer's stream.
        if (remoteVideoRef.current && !isSharer) {
          // Ensure it's a viewer and the ref exists
          if (remoteVideoRef.current.srcObject !== event.streams[0]) {
            remoteVideoRef.current.srcObject = event.streams[0];
            console.log(
              `Remote video srcObject set successfully from ${remoteSocketId}!`
            );
            setStatusMessage(`Receiving stream from ${remoteSocketId}`); // Optional: update status
          } else {
            console.log(
              `Remote video srcObject is already the same stream from ${remoteSocketId}.`
            );
          }
        } else if (isSharer) {
          console.log(
            `Current user is sharer (${socket.current?.id}). Not displaying remote track.`
          );
        } else {
          console.warn(
            "remoteVideoRef.current is null when ontrack fired or user is sharer."
          );
        }
      };

      pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
        if (event.candidate) {
          console.log(
            "Sending ICE candidate:",
            event.candidate.candidate, // Log the actual candidate string for clarity
            "to",
            remoteSocketId
          );
          socket.current?.emit("iceCandidate", {
            candidate: event.candidate,
            roomName: roomId,
            targetSocketId: remoteSocketId,
          });
        } else {
          console.log("ICE candidate gathering finished for", remoteSocketId);
        }
      };

      pc.oniceconnectionstatechange = () => {
        console.log(
          `ICE connection state for ${remoteSocketId}:`,
          pc.iceConnectionState
        );
        if (
          pc.iceConnectionState === "disconnected" ||
          pc.iceConnectionState === "failed" ||
          pc.iceConnectionState === "closed"
        ) {
          console.log(
            `Peer ${remoteSocketId} disconnected or connection failed.`
          );
          // Clean up peer connection from map
          if (peerConnections.current.has(remoteSocketId)) {
            peerConnections.current.delete(remoteSocketId);
          }
          // If the disconnected peer was the sharer, clear remote video
          if (remoteSocketId === sharerId) {
            setSharerId(null);
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = null;
            }
            setStatusMessage(
              "Sharer has disconnected. You can now start sharing."
            );
          }
        }
      };

      // Add signaling state change listener for debugging
      pc.onsignalingstatechange = () => {
        console.log(
          `Signaling state for ${remoteSocketId}:`,
          pc.signalingState
        );
      };

      peerConnections.current.set(remoteSocketId, pc);
      return pc;
    },
    [roomId, localStream, sharerId]
  ); // Dependencies for useCallback

  // Function to create an offer for a specific remote user
  const createOffer = useCallback(
    async (targetSocketId: string): Promise<void> => {
      const pc = getOrCreatePeerConnection(targetSocketId);
      if (!pc) {
        console.error("Peer connection not initialized for offer creation.");
        return;
      }

      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.current?.emit("offer", {
          offer,
          roomName: roomId,
          targetSocketId,
        });
        console.log("Sent offer to", targetSocketId);
      } catch (error) {
        console.error("Error creating or sending offer:", error);
      }
    },
    [getOrCreatePeerConnection, roomId]
  );

  // Handle joining the room
  const handleJoinRoom = async (): Promise<void> => {
    if (roomId.trim() === "") {
      alert("Please enter a room ID.");
      return;
    }
    setJoinedRoom(true);
    socket.current?.emit("joinRoom", roomId);
    setStatusMessage(
      `Joined room ${roomId}. Waiting for sharer or to start sharing.`
    );
    // No peer connection setup here; it will happen when a sharer is known.
  };

  // Handle starting screen sharing
  const shareScreenHandler = async (): Promise<void> => {
    if (!joinedRoom) {
      alert("Please join a room first.");
      return;
    }
    console.log("shareScreenHandler called. joinedRoom:", joinedRoom);

    try {
      console.log("Attempting to start screen capture...");
      const stream: MediaStream | null = await startCapture({
        audio: true,
        video: true,
      });
      console.log("startCapture returned:", stream);

      if (!stream) {
        console.log("Screen capture cancelled or failed. Not setting stream.");
        setStatusMessage("Screen capture cancelled or failed.");
        return;
      }

      // Stop previous local stream tracks if they exist
      if (localStream) {
        console.log("Stopping previous local stream tracks.");
        localStream
          .getTracks()
          .forEach((track: MediaStreamTrack) => track.stop());
      }
      console.log("Stream captured successfully:", stream);
      setLocalStream(stream); // Set the new screen share stream as local stream
      console.log("setLocalStream called for state update."); // This log will show before state updates

      // The `localStream` state will update in the next render cycle.
      // For immediate use, continue to use the `stream` variable.

      setIsSharer(true); // Current user becomes the sharer
      setSharerId(socket.current?.id || null); // Set self as sharer
      setStatusMessage("You are sharing your screen!");
      console.log(
        "UI state updated: isSharer=true, sharerId=",
        socket.current?.id
      );

      // Inform the server that this user is now sharing
      socket.current?.emit("startSharing", roomId);
      console.log("Emitted 'startSharing' to server.");

      // For any existing viewers, add tracks and create offers
      peerConnections.current.forEach(
        (pc: RTCPeerConnection, remoteId: string) => {
          console.log(
            `Sharer: Processing existing peer connection for viewer ${remoteId} to add new tracks.`
          );
          // Remove existing tracks before adding new ones to prevent errors and ensure renegotiation
          pc.getSenders().forEach((sender) => {
            if (sender.track) {
              pc.removeTrack(sender);
              console.log(`Removed existing track from sender for ${remoteId}`);
            }
          });
          // Add new tracks from the *newly captured stream*
          stream.getTracks().forEach((track: MediaStreamTrack) => {
            pc.addTrack(track, stream);
            console.log(`Added new track to peer connection for ${remoteId}`);
          });
          // Create a new offer to renegotiate with existing viewers
          createOffer(remoteId);
        }
      );

      // Listen for when the screen sharing stops (e.g., user clicks stop in browser dialog)
      stream.getVideoTracks()[0].onended = () => {
        console.log("Screen sharing stopped by user (onended event).");
        stopSharingHandler();
      };
    } catch (err: any) {
      console.error("Error accessing screen media:", err);
      alert("Could not access screen. Please ensure permissions are granted.");
      setIsSharer(false);
      setSharerId(null);
      setStatusMessage("Failed to start screen sharing.");
    }
  };

  // Handle stopping screen sharing
  const stopSharingHandler = (): void => {
    if (localStream) {
      console.log("Stopping local stream tracks.");
      localStream
        .getTracks()
        .forEach((track: MediaStreamTrack) => track.stop());
      setLocalStream(null);
    }
    setIsSharer(false);
    setSharerId(null);
    setStatusMessage("Screen sharing stopped.");
    socket.current?.emit("stopSharing", roomId); // Inform server
    // Close all peer connections as the sharer
    peerConnections.current.forEach((pc: RTCPeerConnection) => pc.close());
    peerConnections.current.clear();
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null; // Also clear remote just in case
  };

  // --- Socket.IO initialization and global listeners (runs once on mount) ---
  useEffect(() => {
    socket.current = io(baseUri, {
      autoConnect: false,
      // transports: ["websocket"],
      withCredentials: true,
    });
    socket.current.connect();
    socket.current.on("connect_error", (error) => {
      console.error("Full Error Object:", error);
    });
    socket.current.on("reconnect_attempt", (attemptNumber) => {
      console.log(`🔄 Reconnection attempt #${attemptNumber}`);
    });

    socket.current.on("reconnect_error", (error) => {
      console.error("🔄❌ Reconnection Error:", error);
    });

    socket.current.on("reconnect_failed", () => {
      console.error("🔄❌ Reconnection failed after maximum attempts");
    });

    socket.current.on("reconnect", (attemptNumber) => {
      console.log(`🔄✅ Reconnected after ${attemptNumber} attempts`);
    });

    socket.current.on("connect", () => {
      console.log(
        "Connected to signaling server. Socket ID:",
        socket.current?.id
      );
      setStatusMessage("Connected to signaling server. Enter a room ID.");
    });

    socket.current.on("disconnect", () => {
      console.log("Disconnected from signaling server");
      setJoinedRoom(false);
      setIsSharer(false);
      setSharerId(null);
      setLocalStream(null);
      setStatusMessage("Disconnected. Rejoin a room.");

      peerConnections.current.forEach((pc: RTCPeerConnection) => pc.close());
      peerConnections.current.clear();
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    });

    // Cleanup on unmount
    return () => {
      if (socket.current) {
        socket.current.disconnect();
      }
      peerConnections.current.forEach((pc: RTCPeerConnection) => pc.close());
      peerConnections.current.clear();
      // Ensure localStream is stopped on unmount
      // Note: `localStream` in this closure refers to the value at the time of component mount.
      // For stopping the *current* stream, it's better handled within `stopSharingHandler` or via a more dynamic ref.
      // However, this `useEffect` cleanup is good for initial setup.
      if (localStream) {
        // This `localStream` will be the initial `null` unless the component shares and unmounts rapidly.
        localStream
          .getTracks()
          .forEach((track: MediaStreamTrack) => track.stop());
      }
    };
  }, []); // Empty dependency array means this runs only once on component mount

  // --- Socket.IO listeners that depend on state (runs when dependencies change) ---
  useEffect(() => {
    // Only set up these listeners if socket is connected and user has joined a room
    if (!socket.current || !joinedRoom) return;

    // Event received by a new viewer when a sharer is already in the room
    socket.current.on("sharerAvailable", async (existingSharerId: string) => {
      console.log(
        `Sharer ${existingSharerId} is already in the room. Attempting to connect as viewer.`
      );
      setSharerId(existingSharerId);
      setIsSharer(false); // Ensure the viewer is not marked as sharer
      setStatusMessage(
        `Sharer ${existingSharerId} is active. Waiting for their stream.`
      );
      const pc = getOrCreatePeerConnection(existingSharerId); // Initialize PC for the sharer

      // *** IMPORTANT: The viewer initiates the offer to the existing sharer ***
      try {
        // Add a dummy track or ensure there's something to trigger onnegotiationneeded
        // For a viewer, you technically don't need to add tracks if you only want to receive,
        // but some browsers might behave better if addTrack is called for a full negotiation.
        // For screen sharing, the sharer pushes the stream. The viewer just needs to create an offer
        // to establish the connection for reception.
        // A simple `addTransceiver` can also work if you just want to receive specific media types.
        // For simplicity, we just create the offer.
        const offer = await pc.createOffer({
          offerToReceiveAudio: true,
          offerToReceiveVideo: true,
        });
        await pc.setLocalDescription(offer);
        socket.current?.emit("offer", {
          offer,
          roomName: roomId,
          targetSocketId: existingSharerId, // Send offer TO the sharer
        });
        console.log(`Viewer sent offer to existing sharer ${existingSharerId}`);
      } catch (error) {
        console.error("Error creating offer for existing sharer:", error);
      }
    });

    // Event received by the sharer when a new viewer joins
    socket.current.on("viewerJoined", (viewerSocketId: string) => {
      console.log(
        `New viewer ${viewerSocketId} joined. Creating offer for them.`
      );
      if (isSharer && localStream) {
        // Only the sharer should act on this
        const pc = getOrCreatePeerConnection(viewerSocketId);
        // Ensure the correct local stream is added to the new peer connection
        localStream.getTracks().forEach((track: MediaStreamTrack) => {
          const existingSender = pc
            .getSenders()
            .find((s) => s.track?.kind === track.kind);
          if (existingSender) {
            existingSender.replaceTrack(track); // Replace if track exists
            console.log(
              `Sharer: Replaced existing track for ${viewerSocketId}`
            );
          } else {
            pc.addTrack(track, localStream); // Add if new
            console.log(`Sharer: Added new track for ${viewerSocketId}`);
          }
        });
        createOffer(viewerSocketId);
      } else {
        console.log(
          `Viewer joined (${viewerSocketId}) but current user is not sharer or no localStream.`
        );
      }
    });

    // Event received by viewers when the sharer starts sharing
    socket.current.on("sharerStarted", (newSharerId: string) => {
      console.log(
        `User ${newSharerId} started sharing. Preparing to receive stream.`
      );
      setSharerId(newSharerId);
      setIsSharer(false);
      setStatusMessage(`User ${newSharerId} is now sharing.`);
      // When a sharer *starts* sharing, viewers need to initiate the offer to them.
      // This ensures the viewer explicitly requests the stream.
      // Call getOrCreatePeerConnection to set up the PC, then create an offer.
      const pc = getOrCreatePeerConnection(newSharerId);
      // Since this is `sharerStarted`, the viewer should immediately offer to receive.
      try {
        // If you don't add tracks yourself (as a viewer), you must tell WebRTC you want to receive.
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        createOffer(newSharerId); // Viewer creates an offer to the new sharer
        console.log(`Viewer sent offer to newly started sharer ${newSharerId}`);
      } catch (error) {
        console.error("Error creating offer from viewer to new sharer:", error);
      }
    });

    // Event received by viewers when the sharer stops sharing
    socket.current.on("sharerStopped", (stoppedSharerId: string) => {
      console.log(`Sharer ${stoppedSharerId} stopped sharing.`);
      if (sharerId === stoppedSharerId) {
        setSharerId(null);
        if (remoteVideoRef.current) {
          remoteVideoRef.current.srcObject = null;
        }
        setStatusMessage(
          "Sharer has stopped sharing. You can now become the sharer."
        );
      }
      const pc = peerConnections.current.get(stoppedSharerId);
      if (pc) {
        pc.close();
        peerConnections.current.delete(stoppedSharerId);
        console.log(`Closed PC for stopped sharer ${stoppedSharerId}`);
      }
    });

    // Conflict: Another user is already sharing
    socket.current.on("sharingConflict", (activeSharerId: string) => {
      alert(
        `Another user (${activeSharerId}) is already sharing in this room. You can only view.`
      );
      setIsSharer(false);
      setSharerId(activeSharerId);
      setStatusMessage(
        `User ${activeSharerId} is already sharing. You are a viewer.`
      );
      const pc = getOrCreatePeerConnection(activeSharerId);
      // Same logic as sharerStarted for viewer initiation
      try {
        pc.addTransceiver("video", { direction: "recvonly" });
        pc.addTransceiver("audio", { direction: "recvonly" });
        createOffer(activeSharerId);
        console.log(
          `Viewer sent offer to conflicting sharer ${activeSharerId}`
        );
      } catch (error) {
        console.error(
          "Error creating offer from viewer to conflicting sharer:",
          error
        );
      }
    });

    socket.current.on(
      "offer",
      async (data: { offer: RTCSessionDescriptionInit; senderId: string }) => {
        console.log(
          `Received offer from: ${data.senderId}. Current user is sharer: ${isSharer}, current sharerId: ${sharerId}, localSocketId: ${socket.current?.id}`
        );
        const pc = getOrCreatePeerConnection(data.senderId);
        if (!pc) {
          console.error("Peer connection not found for received offer.");
          return;
        }
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
          console.log(`Set remote description (offer) for ${data.senderId}.`);

          // Only create an answer if you are *not* the sharer sending the offer to yourself (which shouldn't happen)
          // or if you are the sharer receiving an offer from a new viewer who wants your stream.
          // Or if you are a viewer receiving an offer from a sharer.
          // In our updated flow, viewers initiate offers to existing sharers,
          // and sharers initiate offers to new viewers.
          // This "offer" listener primarily means: someone wants to send me something.
          // If I'm the sharer, and a viewer sent me an offer, I respond with an answer.
          // If I'm a viewer, and the sharer sent me an offer, I respond with an answer.

          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          console.log(
            `Created and set local description (answer) for ${data.senderId}.`
          );
          socket.current?.emit("answer", {
            answer,
            roomName: roomId,
            targetSocketId: data.senderId,
          });
          console.log("Sent answer to", data.senderId);
        } catch (error) {
          console.error("Error processing offer:", error);
        }
      }
    );

    socket.current.on(
      "answer",
      async (data: { answer: RTCSessionDescriptionInit; senderId: string }) => {
        console.log("Received answer from:", data.senderId);
        const pc = peerConnections.current.get(data.senderId);
        if (!pc) {
          console.error("Peer connection not found for received answer.");
          return;
        }
        try {
          // Check if remote description is already set to avoid errors
          if (
            pc.remoteDescription &&
            pc.remoteDescription.type === data.answer.type &&
            pc.remoteDescription.sdp === data.answer.sdp
          ) {
            console.log(
              "Remote description (answer) already set and identical for",
              data.senderId
            );
            return;
          }
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
          console.log("Set remote description (answer) for", data.senderId);
        } catch (error) {
          console.error("Error processing answer:", error);
        }
      }
    );

    socket.current.on(
      "iceCandidate",
      async (data: { candidate: RTCIceCandidateInit; senderId: string }) => {
        console.log("Received ICE candidate from:", data.senderId);
        const pc = peerConnections.current.get(data.senderId);
        if (!pc) {
          console.error(
            "Peer connection not found for received ICE candidate."
          );
          return;
        }
        try {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          console.log("Added ICE candidate from", data.senderId);
        } catch (e) {
          console.error("Error adding received ICE candidate", e);
        }
      }
    );

    // Clean up event listeners when component unmounts or dependencies change
    return () => {
      if (socket.current) {
        socket.current.off("sharerAvailable");
        socket.current.off("viewerJoined");
        socket.current.off("sharerStarted");
        socket.current.off("sharerStopped");
        socket.current.off("sharingConflict");
        socket.current.off("offer");
        socket.current.off("answer");
        socket.current.off("iceCandidate");
      }
    };
  }, [
    joinedRoom,
    roomId,
    isSharer,
    sharerId,
    localStream, // Keep localStream here as getOrCreatePeerConnection depends on it.
    getOrCreatePeerConnection,
    createOffer,
  ]);

  // Separate useEffect for updating local video ref when localStream changes
  useEffect(() => {
    if (isSharer && localStream && localVideoRef.current) {
      localVideoRef.current.srcObject = localStream;
      console.log("localVideoRef srcObject set in dedicated useEffect.");
    } else if (localVideoRef.current && !localStream) {
      localVideoRef.current.srcObject = null;
      console.log("localVideoRef srcObject cleared.");
    }
  }, [isSharer, localStream]);

  return (
    <div className="App">
      <h1 className="text-3xl font-bold text-center my-4">
        React WebRTC Screen Share
      </h1>

      <div className="status-area my-4 text-center">
        <p className="text-lg font-medium">{statusMessage}</p>
        {sharerId && (
          <p className="text-sm text-gray-600">Current Sharer: {sharerId}</p>
        )}
      </div>

      {!joinedRoom ? (
        <div className="join-room flex flex-col items-center my-8">
          <input
            type="text"
            placeholder="Enter Room ID"
            value={roomId}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setRoomId(e.target.value)
            }
            className="p-3 border border-gray-300 rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleJoinRoom}
            className="px-6 py-3 bg-blue-600 text-white font-semibold rounded-lg shadow-md hover:bg-blue-700 transition duration-300 ease-in-out"
          >
            Join Room
          </button>
        </div>
      ) : (
        <div className="video-and-controls-container p-6 bg-gray-100 rounded-xl shadow-lg">
          <div className="controls flex justify-center gap-4 mb-6">
            {isSharer ? (
              <button
                onClick={stopSharingHandler}
                className="px-6 py-3 bg-red-600 text-white font-semibold rounded-lg shadow-md hover:bg-red-700 transition duration-300 ease-in-out"
              >
                Stop Sharing
              </button>
            ) : (
              <button
                onClick={shareScreenHandler}
                disabled={sharerId !== null} // Disable if someone else is already sharing
                className={`px-6 py-3 font-semibold rounded-lg shadow-md transition duration-300 ease-in-out ${
                  sharerId !== null
                    ? "bg-gray-400 cursor-not-allowed"
                    : "bg-green-600 text-white hover:bg-green-700"
                }`}
              >
                Share Screen
              </button>
            )}
          </div>

          <div className="video-container flex flex-wrap justify-center gap-6">
            {isSharer && (
              <div className="video-feed bg-white p-4 rounded-lg shadow-md flex flex-col items-center">
                <h2 className="text-xl font-semibold mb-3">
                  Your Screen (Local)
                </h2>
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted // Mute local video to prevent echo
                  playsInline
                  className="w-full max-w-[640px] h-auto rounded-md border border-gray-300 bg-black"
                ></video>
              </div>
            )}

            {sharerId && !isSharer ? ( // Show remote video only if you are not the sharer and there is a sharer
              <div className="video-feed bg-white p-4 rounded-lg shadow-md flex flex-col items-center">
                <h2 className="text-xl font-semibold mb-3">
                  Shared Screen (Remote)
                </h2>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="w-full max-w-[640px] h-auto rounded-md border border-gray-300 bg-black"
                ></video>
              </div>
            ) : (
              !isSharer && (
                <p className="text-lg text-gray-700">
                  Waiting for a user to start sharing...
                </p>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
