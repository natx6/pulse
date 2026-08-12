#!/usr/bin/env python3
"""Generate a simple 1024x1024 app icon (green rounded square + white pill) with stdlib only."""
import struct, zlib

SIZE = 1024
BG = (0, 108, 73, 255)      # primary green #006c49
PILL = (255, 255, 255, 255)

# pill geometry: horizontal capsule centered
cx, cy = SIZE // 2, SIZE // 2
half_len, half_h, r = 300, 120, 120

def in_pill(x, y):
    dx = abs(x - cx)
    dy = abs(y - cy)
    if dy > half_h:
        return False
    if dx <= half_len - r:
        return True
    # end caps
    ex = dx - (half_len - r)
    return ex * ex + dy * dy <= r * r

def in_round_rect(x, y):
    # rounded square background
    m = 60  # corner radius
    if m <= x < SIZE - m or m <= y < SIZE - m:
        return x < SIZE and y < SIZE
    cx_, cy_ = (m if x < m else SIZE - m, m if y < m else SIZE - m)
    return (x - cx_) ** 2 + (y - cy_) ** 2 <= m * m

rows = []
for y in range(SIZE):
    row = bytearray()
    for x in range(SIZE):
        if in_round_rect(x, y):
            row += bytes(PILL if in_pill(x, y) else BG)
        else:
            row += bytes((0, 0, 0, 0))
    rows.append(bytes(row))

def chunk(tag, data):
    c = struct.pack(">I", len(data)) + tag + data
    return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

raw = b"".join(b"\x00" + r for r in rows)
png = (
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(raw, 9))
    + chunk(b"IEND", b"")
)

import os
out = os.path.join(os.path.dirname(__file__), "..", "src-tauri", "icons")
os.makedirs(out, exist_ok=True)
with open(os.path.join(out, "icon.png"), "wb") as f:
    f.write(png)
print("wrote", os.path.join(out, "icon.png"), len(png), "bytes")
