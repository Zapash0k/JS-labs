# @dogfight/shared

Code that runs on both sides of the wire: `src/sim/` (the simulation), `src/prng.js` (seeded PRNG),
`src/protocol.js` (constants, `validateInput`), `src/codec/` (JSON and binary codecs, byte spec in `binary.js`).
No DOM and no Node built-ins; `npm test -w shared` enforces it, checks bit-exact determinism (`npm run hash -w shared`)
and round-trips every codec. See `server/README.md` (Lab 05) for how it is used.
