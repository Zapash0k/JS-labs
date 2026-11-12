import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export class RoomFullError extends Error {
  constructor(room) {
    super(`room ${room.id} is full`);
    this.name = "RoomFullError";
  }
}
export class RoomLimitError extends Error {
  constructor() {
    super("too many rooms");
    this.name = "RoomLimitError";
  }
}
export class RoomExistsError extends Error {
  constructor(id) {
    super(`room ${id} already exists`);
    this.name = "RoomExistsError";
  }
}

/**
 * A room is a Map of players plus events. Listeners run synchronously, in registration order:
 *   "join" (player) · "leave" (player) · "chat" ({ from, text, t }) · "empty" · "closed"
 *   "event" ({ t, type, ... })  — everything worth logging; the match log subscribes to this one.
 */
export class Room extends EventEmitter {
  constructor({ id, name = id, maxPlayers, arena = {} }) {
    super();
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.arena = arena;
    this.players = new Map(); // player.id -> player
    this.createdAt = Date.now();
  }

  get size() {
    return this.players.size;
  }

  #log(type, fields = {}) {
    this.emit("event", { t: Date.now(), type, ...fields });
  }

  join(player) {
    if (this.players.size >= this.maxPlayers) throw new RoomFullError(this);
    this.players.set(player.id, player);
    this.emit("join", player);
    this.#log("join", { player: { id: player.id, name: player.name } });
  }

  leave(player) {
    if (!this.players.delete(player.id)) return;
    this.emit("leave", player);
    this.#log("leave", { player: { id: player.id, name: player.name } });
    if (this.players.size === 0) this.emit("empty");
  }

  chat(player, text) {
    const msg = { from: { id: player.id, name: player.name }, text, t: Date.now() };
    this.emit("chat", msg);
    this.#log("chat", msg);
  }

  /** Calls player.send(message, opts) for everybody. One slow client never blocks the loop. */
  broadcast(message, opts) {
    for (const p of this.players.values()) p.send(message, opts);
  }

  roster() {
    return [...this.players.values()].map(({ id, name }) => ({ id, name }));
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      players: this.size,
      maxPlayers: this.maxPlayers,
      arena: this.arena,
    };
  }

  close() {
    this.#log("room_closed");
    this.emit("closed");
    this.removeAllListeners();
  }
}

export const newPlayerId = () => randomUUID().slice(0, 8);

/** Creates / finds / deletes rooms. Emits "created" (room) and "deleted" (room). */
export class RoomManager extends EventEmitter {
  #rooms = new Map();
  constructor({ maxRooms, maxPlayersPerRoom, emptyRoomTtlMs, defaultArena = {} }) {
    super();
    this.opts = { maxRooms, maxPlayersPerRoom, emptyRoomTtlMs, defaultArena };
  }

  get size() {
    return this.#rooms.size;
  }
  get(id) {
    return this.#rooms.get(id);
  }
  list() {
    return [...this.#rooms.values()];
  }

  create(
    id,
    { name = id, maxPlayers = this.opts.maxPlayersPerRoom, arena, persistent = false } = {},
  ) {
    if (this.#rooms.has(id)) throw new RoomExistsError(id);
    if (this.#rooms.size >= this.opts.maxRooms) throw new RoomLimitError();
    const room = new Room({
      id,
      name,
      maxPlayers: Math.min(maxPlayers, this.opts.maxPlayersPerRoom),
      arena: { ...this.opts.defaultArena, ...arena },
    });
    this.#rooms.set(id, room);
    if (!persistent) {
      room.once("empty", () => this.delete(id));
      // A room nobody ever joins would live forever: reap it after a while.
      const idle = setTimeout(() => room.size === 0 && this.delete(id), this.opts.emptyRoomTtlMs);
      idle.unref();
      room.once("closed", () => clearTimeout(idle));
    }
    this.emit("created", room);
    return room;
  }

  getOrCreate(id, opts) {
    return this.#rooms.get(id) ?? this.create(id, opts);
  }

  delete(id) {
    const room = this.#rooms.get(id);
    if (!room) return false;
    this.#rooms.delete(id);
    this.emit("deleted", room);
    room.close();
    return true;
  }

  closeAll() {
    for (const id of [...this.#rooms.keys()]) this.delete(id);
  }
}
