// DPR-aware canvas that follows the window size.
export function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const size = { w: 0, h: 0 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    size.w = window.innerWidth;
    size.h = window.innerHeight;
    canvas.width = Math.round(size.w * dpr);
    canvas.height = Math.round(size.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  window.addEventListener("resize", resize);
  resize();
  return { ctx, size };
}
