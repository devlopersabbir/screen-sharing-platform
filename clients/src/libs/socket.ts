import { io } from "socket.io-client";
import { baseUri } from "../constants";

export const web_socket = io(baseUri, {
  autoConnect: false,
  transports: ["websocket"],

  timeout: 20000,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: 5,
});
