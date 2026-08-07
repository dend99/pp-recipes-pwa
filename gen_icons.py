#!/usr/bin/env python3
"""Generate PWA PNG icons (pure stdlib, no PIL).

Draws a rounded-square green gradient with a white bowl and a leaf —
a clean "healthy food" mark. Outputs 192, 512 and 180 (apple-touch) px.
"""
import math
import struct
import zlib

BG_TOP = (34, 197, 94)      # emerald-500
BG_BOT = (21, 128, 61)      # green-700
BOWL = (255, 255, 255)
BROTH = (236, 253, 245)     # very light mint
LEAF = (74, 222, 128)       # green-400
LEAF_DARK = (34, 150, 70)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def make(size):
    r = size * 0.22  # corner radius
    px = bytearray()
    cx, cy = size / 2, size / 2
    bowl_cy = size * 0.56
    bowl_r = size * 0.30
    for y in range(size):
        row = bytearray()
        row.append(0)  # PNG filter type 0
        for x in range(size):
            # rounded-square mask (transparent outside)
            inside = True
            for (ox, oy) in ((r, r), (size - r, r), (r, size - r), (size - r, size - r)):
                # only test in the corner quadrants
                if ((x < r and y < r) or (x > size - r and y < r) or
                        (x < r and y > size - r) or (x > size - r and y > size - r)):
                    d = math.hypot(x - ox, y - oy)
                    # pick the nearest corner center
            # simpler: compute distance to the corner of the current quadrant
            qx = r if x < r else (size - r if x > size - r else x)
            qy = r if y < r else (size - r if y > size - r else y)
            if math.hypot(x - qx, y - qy) > r:
                inside = False

            if not inside:
                row += bytes((0, 0, 0, 0))
                continue

            # base vertical gradient
            t = y / size
            col = list(lerp(BG_TOP, BG_BOT, t))
            a = 255

            # bowl (half-circle-ish rounded bowl)
            db = math.hypot(x - cx, y - bowl_cy)
            if db < bowl_r and y > bowl_cy - bowl_r * 0.55:
                # broth vs rim
                if db < bowl_r * 0.86:
                    col = list(BROTH)
                else:
                    col = list(BOWL)

            # leaf sitting on top of the bowl
            lx, ly = x - cx, y - (size * 0.40)
            # rotate 45deg
            ang = math.radians(-35)
            rx = lx * math.cos(ang) - ly * math.sin(ang)
            ry = lx * math.sin(ang) + ly * math.cos(ang)
            ew, eh = size * 0.11, size * 0.20
            if (rx / ew) ** 2 + (ry / eh) ** 2 <= 1.0:
                col = list(LEAF)
                # central vein
                if abs(rx) < size * 0.006:
                    col = list(LEAF_DARK)

            row += bytes((col[0], col[1], col[2], a))
        px += row

    raw = bytes(px)
    compressed = zlib.compress(raw, 9)

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        c += struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff)
        return c

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", compressed) + chunk(b"IEND", b"")


for s, name in ((192, "icons/icon-192.png"), (512, "icons/icon-512.png"),
                (180, "icons/apple-touch-icon.png")):
    with open(name, "wb") as f:
        f.write(make(s))
    print("wrote", name)
