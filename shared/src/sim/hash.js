// FNV-1a over the exact bits of every entity's numbers: two machines agree on the hash only if the
// simulation produced bit-identical state. Used by the determinism test and by /?hashcheck=1 in the browser.
const KIND_CODE = { ship: 1, bullet: 2, asteroid: 3, pickup: 4, explosion: 5 };

export function hashWorld(world) {
  const buf = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;
  const mix = (byte) => {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  };
  const num = (n) => {
    buf.setFloat64(0, n, true);
    for (let i = 0; i < 8; i++) mix(buf.getUint8(i));
  };
  const entities = [...world].filter((e) => e.alive).sort((a, b) => a.id - b.id);
  for (const e of entities) {
    mix(KIND_CODE[e.kind] ?? 0);
    num(e.id);
    num(e.pos.x);
    num(e.pos.y);
    num(e.vel.x);
    num(e.vel.y);
    num(e.angle);
  }
  return h.toString(16).padStart(8, "0");
}
