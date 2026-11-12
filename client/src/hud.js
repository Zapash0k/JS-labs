// Floating score popups (Lab 03, M2). Like audio.js, it only listens to the world's events;
// the simulation does not know it exists.

const LIFETIME_MS = 900;

export function createHud() {
  const popups = [];

  return {
    attach(events, signal) {
      events.addEventListener(
        "scoreChanged",
        (e) => {
          const { delta, pos } = e.detail;
          popups.push({ text: `+${delta}`, x: pos.x, y: pos.y, born: performance.now() });
        },
        { signal },
      );
    },
    draw(ctx, now = performance.now()) {
      ctx.save();
      ctx.font = "bold 18px ui-monospace, Consolas, monospace";
      ctx.textAlign = "center";
      for (let i = popups.length - 1; i >= 0; i--) {
        const p = popups[i];
        const age = now - p.born;
        if (age > LIFETIME_MS) {
          popups.splice(i, 1);
          continue;
        }
        ctx.fillStyle = `rgba(255, 224, 102, ${1 - age / LIFETIME_MS})`;
        ctx.fillText(p.text, p.x, p.y - age * 0.04);
      }
      ctx.restore();
    },
  };
}
