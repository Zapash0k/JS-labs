"""Generates the placeholder sprite sheet and sound effects (run once: python3 scripts/make-assets.py).
Needs Pillow. The outputs are committed, so this is only for regenerating them."""
import math, random, struct, wave
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "assets"
SS = 4  # supersampling factor

# ---------- sprite sheet 224x64, frames must match public/assets/manifest.json ----------
sheet = Image.new("RGBA", (224 * SS, 64 * SS), (0, 0, 0, 0))
d = ImageDraw.Draw(sheet)
def P(x, y): return (x * SS, y * SS)

def ship(ox, thrust):
    cx, cy = ox + 16, 16
    if thrust:
        d.polygon([P(cx - 10, cy - 5), P(cx - 15, cy), P(cx - 10, cy + 5)], fill=(255, 157, 46, 255))
    d.polygon([P(cx + 14, cy), P(cx - 12, cy - 9), P(cx - 7, cy), P(cx - 12, cy + 9)],
              fill=(232, 241, 255, 255), outline=(106, 168, 255, 255), width=2 * SS)
ship(0, False); ship(32, True)

def disc(x, y, r, fill):
    d.ellipse([P(x - r, y - r), P(x + r, y + r)], fill=fill)
disc(68, 4, 3.5, (255, 224, 102, 255))      # bullet
disc(76, 4, 3.5, (106, 255, 200, 255))      # homing bullet

def pickup(ox, color, letter):
    cx, cy = ox + 12, 44
    d.ellipse([P(cx - 10, cy - 10), P(cx + 10, cy + 10)], outline=color, width=2 * SS)
    d.text(P(cx - 3, cy - 6), letter, fill=color)
pickup(0, (106, 255, 200, 255), "S"); pickup(24, (255, 224, 102, 255), "R"); pickup(48, (255, 140, 240, 255), "H")

def asteroid(ox, color, seed):
    rnd = random.Random(seed)
    cx, cy = ox + 32, 32
    pts = []
    for i in range(10):
        a = i / 10 * math.tau
        r = 26 * (0.75 + rnd.random() * 0.35)
        pts.append(P(cx + math.cos(a) * r, cy + math.sin(a) * r))
    d.polygon(pts, fill=(color[0] // 5, color[1] // 5, color[2] // 5, 255), outline=color, width=2 * SS)
    for _ in range(3):
        x, y, r = cx + rnd.uniform(-10, 10), cy + rnd.uniform(-10, 10), rnd.uniform(3, 6)
        d.ellipse([P(x - r, y - r), P(x + r, y + r)], outline=color, width=SS)
asteroid(96, (154, 167, 189, 255), 7); asteroid(160, (255, 106, 106, 255), 11)

sheet.resize((224, 64), Image.LANCZOS).save(OUT / "sprites.png", optimize=True)

# ---------- sound effects: 16-bit mono 22.05 kHz WAV ----------
RATE = 22050
def write(name, samples):
    with wave.open(str(OUT / "sfx" / name), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(b"".join(struct.pack("<h", int(max(-1, min(1, s)) * 32000)) for s in samples))

rnd = random.Random(1)
def shoot():  # falling chirp
    n, out, ph = int(RATE * 0.14), [], 0.0
    for i in range(n):
        t = i / n
        ph += 2 * math.pi * (1400 - 1000 * t) / RATE
        out.append(0.5 * (1 if math.sin(ph) > 0 else -1) * (1 - t) ** 2)
    return out
def hit():    # short noise tick + low thump
    n, out = int(RATE * 0.12), []
    for i in range(n):
        t = i / n
        out.append(((rnd.random() * 2 - 1) * 0.5 + 0.5 * math.sin(2 * math.pi * 180 * i / RATE)) * (1 - t) ** 3)
    return out
def explosion():  # low-passed noise, long decay
    n, out, lp = int(RATE * 0.7), [], 0.0
    for i in range(n):
        t = i / n
        lp += (rnd.random() * 2 - 1 - lp) * (0.35 - 0.28 * t)
        out.append(lp * 1.6 * (1 - t) ** 2)
    return out
write("shoot.wav", shoot()); write("hit.wav", hit()); write("explosion.wav", explosion())
print("assets written to", OUT)
