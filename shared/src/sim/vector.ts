// Immutable 2D vector: `x` and `y` are readonly and every method returns a NEW vector.
// (The old *InPlace hot-path variants were never called; with readonly fields they cannot exist.)
export class Vector2 {
  readonly x: number;
  readonly y: number;

  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }

  static fromAngle(angle: number, length = 1): Vector2 {
    return new Vector2(Math.cos(angle) * length, Math.sin(angle) * length);
  }

  clone(): Vector2 {
    return new Vector2(this.x, this.y);
  }
  add(v: Vector2): Vector2 {
    return new Vector2(this.x + v.x, this.y + v.y);
  }
  sub(v: Vector2): Vector2 {
    return new Vector2(this.x - v.x, this.y - v.y);
  }
  scale(k: number): Vector2 {
    return new Vector2(this.x * k, this.y * k);
  }
  dot(v: Vector2): number {
    return this.x * v.x + this.y * v.y;
  }
  length(): number {
    return Math.hypot(this.x, this.y);
  }
  normalize(): Vector2 {
    const len = this.length();
    return len === 0 ? new Vector2() : this.scale(1 / len);
  }
  rotate(angle: number): Vector2 {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return new Vector2(this.x * c - this.y * s, this.x * s + this.y * c);
  }
}
