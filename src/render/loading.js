// Loading screen on the canvas: a real progress bar (items settled / items total).
export function drawLoading(ctx, w, h, state, now = performance.now()) {
  const { done, total, error } = state;
  ctx.fillStyle = "#05060a";
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = w / 2;
  const cy = h / 2;

  ctx.fillStyle = "#e8f1ff";
  ctx.font = "bold 32px ui-monospace, Consolas, monospace";
  ctx.fillText("DOGFIGHT", cx, cy - 70);

  const bw = Math.min(420, w - 80);
  const frac = total ? done / total : 0;
  ctx.strokeStyle = error ? "#ff6a6a" : "#6aa8ff";
  ctx.lineWidth = 2;
  ctx.strokeRect(cx - bw / 2, cy - 10, bw, 20);
  ctx.fillStyle = error ? "#ff6a6a" : "#6aa8ff";
  ctx.fillRect(cx - bw / 2 + 3, cy - 7, (bw - 6) * frac, 14);

  ctx.font = "14px ui-monospace, Consolas, monospace";
  ctx.fillStyle = "#9dffb0";
  ctx.fillText(total ? `${done} / ${total} assets` : "contacting server…", cx, cy + 34);

  if (!error) {
    // A spinner driven by the clock proves the loop keeps running while assets load.
    const a = (now / 300) % (Math.PI * 2);
    ctx.strokeStyle = "#9dffb0";
    ctx.beginPath();
    ctx.arc(cx, cy + 70, 10, a, a + Math.PI * 1.3);
    ctx.stroke();
    ctx.fillStyle = "#6b7790";
    ctx.fillText("Esc cancels", cx, cy + 100);
  } else {
    ctx.fillStyle = "#ff6a6a";
    ctx.fillText(error, cx, cy + 64);
    ctx.fillStyle = "#e8f1ff";
    ctx.fillRect(cx - 80, cy + 84, 160, 34);
    ctx.fillStyle = "#05060a";
    ctx.font = "bold 14px ui-monospace, Consolas, monospace";
    ctx.fillText("Retry (click / any key)", cx, cy + 101);
  }
  ctx.restore();
}
