// Netgraph (Lab 05, M1): a small overlay with the numbers that explain how the connection feels.
const FONT = "12px ui-monospace, Consolas, monospace";

function spark(ctx, values, x, y, w, h, { max, color, label }) {
  ctx.strokeStyle = "#2b3a58";
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = "#6b7790";
  ctx.fillText(label, x + 4, y + 11);
  if (values.length < 2) return;
  const top = Math.max(max, ...values);
  ctx.strokeStyle = color;
  ctx.beginPath();
  values.forEach((v, i) => {
    const px = x + (i / (values.length - 1)) * w;
    const py = y + h - (v / top) * (h - 2) - 1;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
}

export function drawNetgraph(ctx, net, x, y, { codec, connected }) {
  const s = net.stats;
  const kb = (n) => (n / 1024).toFixed(1);
  const lines = [
    `RTT ${s.rtt.toFixed(0)} ms   snapshots ${(1000 / (s.snapshotIntervalMs || 1000 / 30)).toFixed(0)}/s (age ${s.snapshotAgeMs.toFixed(0)} ms)`,
    `down ${kb(s.bytesInPerSec)} KB/s   up ${kb(s.bytesOutPerSec)} KB/s   codec ${codec}`,
    `pending inputs ${s.pending}   interpolation ${net.interp.delayMs.toFixed(0)} ms (starved ${net.interp.starved})`,
    `correction ${s.correction.toFixed(3)} px (avg ${s.correctionAvg.toFixed(3)})   hp ${s.hp}`,
    `${net.options.predict ? "prediction on" : "PREDICTION OFF"} · ${net.options.reconcile ? "reconcile on" : "RECONCILE OFF"}${net.options.nondeterministic ? " · NONDETERMINISTIC" : ""}${connected ? "" : " · DISCONNECTED"}`,
  ];
  ctx.save();
  ctx.font = FONT;
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(5, 6, 10, 0.65)";
  ctx.fillRect(x - 6, y - 14, 372, 14 * lines.length + 82);
  ctx.fillStyle = connected ? "#9dffb0" : "#ff6a6a";
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * 14));
  const gy = y + lines.length * 14 + 4;
  spark(ctx, s.rttHistory, x, gy, 176, 52, { max: 100, color: "#6aa8ff", label: "RTT ms" });
  spark(ctx, s.correctionHistory, x + 186, gy, 176, 52, {
    max: 2,
    color: "#ffe066",
    label: "correction px",
  });
  ctx.restore();
}
