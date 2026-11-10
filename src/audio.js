// Sound (Lab 03, M2). Owns the AudioContext. The simulation never imports this file:
// the World dispatches events and `attach()` subscribes to them.

export function createAudio({ volume = 0.4 } = {}) {
  const Ctor = window.AudioContext ?? window.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio is not available");
  const ctx = new Ctor(); // starts "suspended" until a user gesture
  const master = ctx.createGain();
  master.gain.value = volume;
  master.connect(ctx.destination);

  const buffers = new Map();

  // Browsers only let an AudioContext run after a user gesture: resume on the first click/key.
  const gesture = new AbortController();
  const unlock = async () => {
    if (ctx.state !== "running") await ctx.resume().catch(() => {});
    if (ctx.state === "running") gesture.abort();
  };
  for (const type of ["pointerdown", "keydown"]) {
    window.addEventListener(type, unlock, { signal: gesture.signal });
  }

  function play(name, { gain = 1, rate = 1 } = {}) {
    const buffer = buffers.get(name);
    if (!buffer || ctx.state !== "running") return;
    const source = ctx.createBufferSource(); // cheap, one-shot, overlaps freely
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const g = ctx.createGain();
    g.gain.value = gain;
    source.connect(g).connect(master);
    source.start();
  }

  return {
    ctx,
    get unlocked() {
      return ctx.state === "running";
    },
    setBuffers(sounds) {
      for (const [name, buffer] of Object.entries(sounds)) buffers.set(name, buffer);
    },
    play,
    /** Subscribe to the world's events; unsubscribed when `signal` aborts. */
    attach(events, signal) {
      const jitter = () => 0.92 + Math.random() * 0.16;
      events.addEventListener("fired", () => play("shoot", { gain: 0.6, rate: jitter() }), {
        signal,
      });
      events.addEventListener("hit", () => play("hit", { rate: jitter() }), { signal });
      events.addEventListener("exploded", () => play("explosion", { rate: jitter() }), { signal });
    },
  };
}
