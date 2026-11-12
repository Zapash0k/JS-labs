// Immutable-style 2D vector: the regular methods return NEW vectors.
// The *InPlace variants mutate `this` and exist for hot paths only.
export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle, length = 1) {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  clone() {
    return new Vector2(this.x, this.y);
  }
  add(v) {
    return new Vector2(this.x + v.x, this.y + v.y);
  }
  sub(v) {
    return new Vector2(this.x - v.x, this.y - v.y);
  }
  scale(k) {
    return new Vector2(this.x * k, this.y * k);
  }
  dot(v) {
    return this.x * v.x + this.y * v.y;
  }
  length() {
    return Math.hypot(this.x, this.y);
  }
  normalize() {
    const len = this.length();
    return len === 0 ? new Vector2() : this.scale(1 / len);
  }
  rotate(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }

  addInPlace(v) {
    this.x += v.x;
    this.y += v.y;
    return this;
  }
  scaleInPlace(k) {
    this.x *= k;
    this.y *= k;
    return this;
  }
}
