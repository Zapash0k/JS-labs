// Lobby data layer (Lab 03, M3). No DOM here: it fetches rooms and dispatches events;
// lobbyView.js renders. Events: "roomsChanged" (detail: rooms), "failed" (detail: Error),
// "joined" (detail: { room, name }).
import { fetchJson, postJson, withRetry } from "../assets/loader.js";

export class Lobby extends EventTarget {
  #opts;
  #life = null; // AbortController: alive while the lobby screen is visible
  #timer = null;
  #inflight = false;

  constructor({
    url = "/api/rooms",
    intervalMs = 3000,
    timeoutMs = 4000,
    attempts = 2,
    baseMs = 300,
    fetchRooms = fetchJson,
  } = {}) {
    super();
    this.#opts = { url, intervalMs, timeoutMs, attempts, baseMs, fetchRooms };
    this.rooms = [];
  }

  /** The player is looking at the lobby: refresh now and on an interval. */
  enter() {
    if (this.#life) return;
    this.#life = new AbortController();
    this.refresh();
    this.#timer = setInterval(() => this.refresh(), this.#opts.intervalMs);
  }

  /** The player left: stop the timer and cancel any request still in flight. */
  leave() {
    clearInterval(this.#timer);
    this.#timer = null;
    this.#life?.abort();
    this.#life = null;
  }

  async refresh() {
    const life = this.#life;
    if (!life || this.#inflight) return;
    this.#inflight = true;
    const { url, timeoutMs, attempts, baseMs, fetchRooms } = this.#opts;
    try {
      const rooms = await withRetry(
        () =>
          fetchRooms(url, {
            signal: AbortSignal.any([life.signal, AbortSignal.timeout(timeoutMs)]),
          }),
        { attempts, baseMs, signal: life.signal },
      );
      if (life.signal.aborted) return; // left while the response was arriving: drop it
      if (!Array.isArray(rooms)) throw new TypeError("rooms response is not a list");
      this.rooms = rooms;
      this.dispatchEvent(new CustomEvent("roomsChanged", { detail: rooms }));
    } catch (error) {
      if (life.signal.aborted) return; // cancelling is not an error
      this.dispatchEvent(new CustomEvent("failed", { detail: error }));
    } finally {
      this.#inflight = false;
    }
  }

  /** POST /api/rooms, then refresh the list. Rejects with HttpError (409 name taken, 422 invalid name). */
  async createRoom(name) {
    const room = await postJson(this.#opts.url, { name }, { signal: this.#life?.signal });
    await this.refresh();
    return room;
  }

  join(roomId, name) {
    const room = this.rooms.find((r) => r.id === roomId);
    if (!room) throw new Error(`unknown room: ${roomId}`);
    this.leave();
    this.dispatchEvent(new CustomEvent("joined", { detail: { room, name } }));
  }
}
