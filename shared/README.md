# @dogfight/shared

Code that runs on both sides of the wire, written in **TypeScript** (Lab 06):

- `src/sim/` — the simulation (`World`, `Ship`, …). `Vector2` is immutable (`readonly x, y`); entities are a discriminated union (`SimEntity`, switch on `kind`).
- `src/brand.ts` — branded numbers `EntityId`, `Tick`, `Seq` (plain numbers at runtime, distinct types at compile time).
- `src/constants.ts` — wire constants (`TICK_HZ`, `KIND`, `EFFECT_NAMES`, …). No zod, so the sim stays light.
- `src/protocol.ts` — **the** protocol: zod schemas → inferred types (`ClientMessage`, `ServerMessage`, `Snapshot`) → `parseClientMessage` / `parseServerMessage`, which take `unknown` and return a `Result`.
- `src/codec/` — `Codec` interface with a JSON and a binary implementation (byte spec in `binary.ts`).
- `src/prng.ts` — seeded PRNG.

No DOM and no Node built-ins; `npm test -w shared` enforces it, checks bit-exact determinism (`npm run hash -w shared`)
and round-trips every codec. `npm run typecheck -w shared` runs `tsc --noEmit` under `strict` + `noUncheckedIndexedAccess`.

Consumers keep importing `@dogfight/shared/protocol.js`, `@dogfight/shared/sim/world.js`, … — the `exports` map in
`package.json` points those names at the `.ts` files. Node (>= 22.18) strips the types natively, Vite transpiles them.
Because of that only _erasable_ syntax is allowed (`erasableSyntaxOnly`): no `enum`, no constructor parameter properties.
See `server/README.md` (Lab 05) for how it is used.
