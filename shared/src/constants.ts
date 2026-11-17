// Wire constants shared by client and server. No zod here: the simulation imports this file, and the
// sim must stay light. Schemas and parsers live in protocol.ts, which re-exports everything below.
import type { EntityId } from "./brand.ts";

export const PROTOCOL_VERSION = 1;
export const TICK_HZ = 30; // server simulation and snapshot rate; the networked client simulates at the same rate
export const TICK_DT = 1 / TICK_HZ;
export const WORLD_SIZE = Object.freeze({ w: 1280, h: 720 }); // authoritative world, in px

// Entity kinds that travel in a snapshot (an explosion is client-side only).
export const KIND = Object.freeze({ ship: 1, bullet: 2, asteroid: 3, pickup: 4 });
export type SnapshotKind = keyof typeof KIND;
export const KIND_NAME: Readonly<Record<number, SnapshotKind>> = Object.freeze({
  1: "ship",
  2: "bullet",
  3: "asteroid",
  4: "pickup",
});

export const EFFECT_NAMES = Object.freeze(["shield", "rapid", "homing"] as const);
export type Effect = (typeof EFFECT_NAMES)[number];

export const EVENT_TYPES = Object.freeze(["fired", "hit", "exploded"] as const);
export type EventType = (typeof EVENT_TYPES)[number];
export const EVENT: Readonly<Record<EventType, number>> = Object.freeze({
  fired: 1,
  hit: 2,
  exploded: 3,
});
export const EVENT_NAME: Readonly<Record<number, EventType>> = Object.freeze({
  1: "fired",
  2: "hit",
  3: "exploded",
});

export const NO_SLOT = 255; // "not a player" in slot fields

/** Snapshot entity ids are u16 on the wire (both codecs), so the builder masks them. */
export const netId = (id: EntityId): number => id & 0xffff;
