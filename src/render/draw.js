export const lerp = (a, b, t) => a + (b - a) * t;

// Shortest-arc interpolation, safe across the ±PI seam and for unbounded angles.
export function lerpAngle(a, b, t) {
  const TAU = Math.PI * 2;
  const d = ((((b - a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
  return a + d * t;
}

export function makeStars(count, w, h) {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: count }, () => ({
    x: rnd() * w,
    y: rnd() * h,
    r: rnd() * 1.4 + 0.3,
    a: rnd() * 0.6 + 0.3,
  }));
}

export function drawBackground(ctx, w, h, stars, background = "#05060a") {
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(80, 110, 160, 0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= w; x += 80) {
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
  }
  for (let y = 0; y <= h; y += 80) {
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
  }
  ctx.stroke();

  for (const s of stars) {
    ctx.fillStyle = `rgba(255,255,255,${s.a})`;
    ctx.beginPath();
    ctx.arc((s.x / 1) % w, (s.y / 1) % h, s.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawShield(ctx, x, y) {
  ctx.strokeStyle = "rgba(106, 255, 200, 0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, 22, 0, Math.PI * 2);
  ctx.stroke();
}

// Sprite versions (Lab 03). Each returns false when the frame is missing, so the caller can
// fall back to the vector drawing and the game stays playable without the sheet.
function spriteFor(ctx, sprites, e, d) {
  switch (e.kind) {
    case "ship":
      if (e.invuln > 0 && Math.floor(e.invuln * 10) % 2 === 0) return true; // blink
      if (!sprites.draw(ctx, e.thrust ? "shipThrust" : "ship", d.x, d.y, d.angle)) return false;
      if (e.shield > 0) drawShield(ctx, d.x, d.y);
      return true;
    case "bullet":
      return sprites.draw(ctx, e.behaviors.length ? "bulletHoming" : "bullet", d.x, d.y, d.angle);
    case "asteroid": {
      const hunter = e.behaviors.some((b) => b.name === "homing");
      return sprites.draw(
        ctx,
        hunter ? "asteroidHunter" : "asteroid",
        d.x,
        d.y,
        d.angle,
        e.radius * 2.3,
      );
    }
    case "pickup": {
      const name = `pickup${e.effect[0].toUpperCase()}${e.effect.slice(1)}`;
      return sprites.draw(ctx, name, d.x, d.y, 0);
    }
    default:
      return false;
  }
}

// The ship is drawn at the origin pointing right (+x); the canvas is moved/rotated.
export function drawShip(ctx, { x, y, angle, thrust, shield = false, blink = false }) {
  if (blink) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  if (shield) drawShield(ctx, 0, 0);

  if (thrust) {
    ctx.fillStyle = "#ff9d2e";
    ctx.beginPath();
    ctx.moveTo(-10, -5);
    ctx.lineTo(-10 - 12 - Math.random() * 10, 0);
    ctx.lineTo(-10, 5);
    ctx.closePath();
    ctx.fill();
  }

  ctx.fillStyle = "#e8f1ff";
  ctx.strokeStyle = "#6aa8ff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-12, -9);
  ctx.lineTo(-7, 0);
  ctx.lineTo(-12, 9);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

// Interpolated draw state of an entity; skips an axis that wrapped this step.
function drawState(e, alpha, size) {
  const wrappedX = Math.abs(e.pos.x - e.prevPos.x) > size.w / 2;
  const wrappedY = Math.abs(e.pos.y - e.prevPos.y) > size.h / 2;
  return {
    x: wrappedX ? e.pos.x : lerp(e.prevPos.x, e.pos.x, alpha),
    y: wrappedY ? e.pos.y : lerp(e.prevPos.y, e.pos.y, alpha),
    angle: lerpAngle(e.prevAngle, e.angle, alpha),
  };
}

function drawBullet(ctx, { x, y }, e) {
  ctx.fillStyle = e.behaviors.length ? "#6affc8" : "#ffe066";
  ctx.beginPath();
  ctx.arc(x, y, e.radius, 0, Math.PI * 2);
  ctx.fill();
}

function drawAsteroid(ctx, { x, y, angle }, e) {
  const hunter = e.behaviors.some((b) => b.name === "homing");
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.strokeStyle = hunter ? "#ff6a6a" : "#9aa7bd";
  ctx.lineWidth = 2;
  ctx.beginPath();
  e.shape.forEach((k, i) => {
    const a = (i / e.shape.length) * Math.PI * 2;
    const px = Math.cos(a) * e.radius * k;
    const py = Math.sin(a) * e.radius * k;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
}

const PICKUP_COLOR = { shield: "#6affc8", rapid: "#ffe066", homing: "#ff8cf0" };

function drawPickup(ctx, { x, y }, e) {
  ctx.strokeStyle = PICKUP_COLOR[e.effect];
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, e.radius, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = PICKUP_COLOR[e.effect];
  ctx.font = "bold 12px ui-monospace, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(e.effect[0].toUpperCase(), x, y + 1);
  ctx.textAlign = "start";
}

function drawExplosion(ctx, e, duration) {
  ctx.fillStyle = `rgba(255, 170, 60, ${Math.max(0, e.ttl / duration)})`;
  for (const p of e.particles) ctx.fillRect(p.pos.x - 1.5, p.pos.y - 1.5, 3, 3);
}

export function drawWorld(ctx, world, alpha, size, sprites = null) {
  for (const e of world) {
    if (!e.alive) continue;
    if (e.kind === "explosion") {
      drawExplosion(ctx, e, e.constructor.DURATION);
      continue;
    }
    const d = drawState(e, alpha, size);
    if (sprites && spriteFor(ctx, sprites, e, d)) continue;
    if (e.kind === "ship") {
      drawShip(ctx, {
        ...d,
        thrust: e.thrust,
        shield: e.shield > 0,
        blink: e.invuln > 0 && Math.floor(e.invuln * 10) % 2 === 0,
      });
    } else if (e.kind === "bullet") drawBullet(ctx, d, e);
    else if (e.kind === "asteroid") drawAsteroid(ctx, d, e);
    else if (e.kind === "pickup") drawPickup(ctx, d, e);
  }
}

export function drawHud(ctx, stats, extra = []) {
  const lines = [
    `steps/s: ${stats.stepsPerSec}`,
    `frames/s: ${stats.fps}`,
    `frame time: ${stats.frameMs.toFixed(1)} ms`,
    `jitter (σ): ${stats.jitterMs.toFixed(2)} ms`,
    `loop: ${stats.mode}, ${stats.fixed ? "fixed" : "variable"} step`,
    ...extra,
  ];
  ctx.save();
  ctx.font = "14px ui-monospace, Consolas, monospace";
  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(8, 8, 330, lines.length * 20 + 12);
  ctx.fillStyle = "#9dffb0";
  lines.forEach((line, i) => ctx.fillText(line, 16, 14 + i * 20));
  ctx.restore();
}
