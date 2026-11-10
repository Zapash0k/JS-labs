// Sprite sheet: one decoded image + named source rectangles from manifest.frames.
export function createSprites(image, frames) {
  return {
    has: (name) => Object.hasOwn(frames, name),
    /** Draws frame `name` centred at (x, y), rotated; `size` rescales by width. Returns false if unknown. */
    draw(ctx, name, x, y, angle = 0, size = null) {
      if (!Object.hasOwn(frames, name)) return false;
      const [sx, sy, sw, sh] = frames[name];
      const k = size == null ? 1 : size / sw;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(angle);
      ctx.drawImage(image, sx, sy, sw, sh, (-sw * k) / 2, (-sh * k) / 2, sw * k, sh * k);
      ctx.restore();
      return true;
    },
  };
}
