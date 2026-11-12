// WebSocket client wrapper (Lab 04, M2).
//  - messages are dispatched by `type`: conn.on("roster", fn) or the "message" event for everything
//  - send() queues while the socket is not open and flushes after the (re)connect
//  - reconnects with exponential backoff + full jitter; `hello()` is re-sent first after every reconnect
//    (that is how the player re-joins its room)
//  - events: "open", "close" ({ code, reason }), "reconnecting" ({ attempt, delayMs }), "message", "message:<type>"

// Close codes after which retrying cannot help (same list as server/src/protocol.js; Lab 05 moves it to shared/).
const NO_RECONNECT = new Set([1002, 1003, 1008, 1009, 4001, 4002, 4003, 4004]);
const PROTOCOL_VERSION = 1;
const QUEUE_LIMIT = 100;

export class Connection extends EventTarget {
  #opts;
  #ws = null;
  #queue = [];
  #attempt = 0;
  #timer = null;
  #wanted = false; // false after close(): no more reconnects

  constructor({
    url,
    hello = null,
    WebSocketImpl = globalThis.WebSocket,
    baseMs = 500,
    maxMs = 10_000,
    random = Math.random,
  }) {
    super();
    this.#opts = { url, hello, WebSocketImpl, baseMs, maxMs, random };
  }

  get connected() {
    return this.#ws?.readyState === 1; // OPEN
  }

  open() {
    this.#wanted = true;
    this.#connect();
  }

  close(code = 1000) {
    this.#wanted = false;
    clearTimeout(this.#timer);
    this.#ws?.close(code);
  }

  send(msg) {
    const text = JSON.stringify({ v: PROTOCOL_VERSION, ...msg });
    if (this.connected) {
      this.#ws.send(text);
    } else {
      this.#queue.push(text);
      if (this.#queue.length > QUEUE_LIMIT) this.#queue.shift(); // never grow without bound while offline
    }
  }

  /** Subscribe to one message type. Returns an unsubscribe function. */
  on(type, handler) {
    const listener = (e) => handler(e.detail);
    this.addEventListener(`message:${type}`, listener);
    return () => this.removeEventListener(`message:${type}`, listener);
  }

  #emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #connect() {
    if (this.#ws) return;
    const { url, hello, WebSocketImpl } = this.#opts;
    const ws = new WebSocketImpl(url);
    this.#ws = ws;

    ws.onopen = () => {
      this.#attempt = 0;
      if (hello) ws.send(JSON.stringify({ v: PROTOCOL_VERSION, ...hello() })); // always first on the wire
      for (const text of this.#queue.splice(0)) ws.send(text);
      this.#emit("open");
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // the server only sends JSON; ignore anything else
      }
      if (typeof msg?.type !== "string") return;
      this.#emit("message", msg);
      this.#emit(`message:${msg.type}`, msg);
    };
    ws.onerror = () => {}; // always followed by "close", which does the work
    ws.onclose = (event) => {
      this.#ws = null;
      this.#emit("close", { code: event.code, reason: event.reason });
      if (this.#wanted && !NO_RECONNECT.has(event.code)) this.#scheduleReconnect();
    };
  }

  #scheduleReconnect() {
    const { baseMs, maxMs, random } = this.#opts;
    const delayMs = random() * Math.min(maxMs, baseMs * 2 ** this.#attempt);
    this.#attempt++;
    this.#emit("reconnecting", { attempt: this.#attempt, delayMs });
    this.#timer = setTimeout(() => this.#wanted && this.#connect(), delayMs);
  }
}

export const wsUrl = (loc = globalThis.location) =>
  `${loc.protocol === "https:" ? "wss" : "ws"}://${loc.host}/ws`;
