// M4: why an unhandled "error" event or an unhandled rejection takes the whole process down.
//   node scripts/crash-demo.mjs error            -> crashes (no 'error' listener on the socket)
//   node scripts/crash-demo.mjs error-fixed      -> survives
//   node scripts/crash-demo.mjs rejection        -> crashes (async handler throws, nobody awaits it)
//   node scripts/crash-demo.mjs rejection-fixed  -> survives
import { WebSocket, WebSocketServer } from "ws";

const mode = process.argv[2] ?? "error";
const wss = new WebSocketServer({ port: 0, maxPayload: 1024 });
const { port } = wss.address();

wss.on("connection", (socket) => {
  if (mode === "error-fixed") socket.on("error", (err) => console.log(`handled: ${err.message}`));
  // mode "error": no socket.on("error") -> the oversize frame below emits 'error' with no listener -> throw

  if (mode.startsWith("rejection")) {
    const handle = async () => {
      throw new Error("handler bug (e.g. a failed DB call)");
    };
    socket.on(
      "message",
      mode === "rejection"
        ? handle
        : (data) => handle(data).catch((err) => console.log(`handled: ${err.message}`)),
    );
  }
});

const client = new WebSocket(`ws://127.0.0.1:${port}`);
client.on("error", () => {});
client.on("open", () => client.send(mode.startsWith("rejection") ? "hi" : "x".repeat(2048)));

setTimeout(() => {
  console.log(`mode "${mode}": still alive after 500 ms`);
  client.terminate();
  wss.close();
}, 500);
