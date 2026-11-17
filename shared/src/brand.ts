// Branded numbers: the same runtime value (a plain number), a different compile-time type.
// Passing a `Tick` where a `Seq` is expected is a compile error, and costs nothing at runtime.
declare const tag: unique symbol;
export type Brand<T, B extends string> = T & { readonly [tag]: B };

export type EntityId = Brand<number, "EntityId">; // assigned by World.spawn
export type Tick = Brand<number, "Tick">; // server simulation tick
export type Seq = Brand<number, "Seq">; // client input sequence number

// The ONE place a plain number becomes a branded one: a single justified type assertion.
const brand = <B extends Brand<number, string>>(n: number): B => n as B;

export const asEntityId = (n: number): EntityId => brand<EntityId>(n);
export const asTick = (n: number): Tick => brand<Tick>(n);
export const asSeq = (n: number): Seq => brand<Seq>(n);
