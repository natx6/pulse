#!/usr/bin/env python3
"""Generate the Pulse app icon (blue rounded square + bold white P) with stdlib only.

The P matches the in-app marks: bold, white, on primary blue #0060a8.
Rendered with 2x supersampling so edges stay smooth at small sizes.
"""
import struct
import zlib

SIZE = 1024
SS = 2  # supersample factor
BG = (0, 96, 168, 255)      # primary blue #0060a8
FG = (255, 255, 255, 255)

# P geometry (final pixels; scaled by SS internally). Bold geometric P:
# full-height stem on the left, bowl across the top half.
CX = CY = SIZE // 2
TOP, BOWL_BOT = CY - 330, CY + 90     # bowl vertical extent
BAR = 130                             # stroke thickness
STEM_L, STEM_R = CX - 260, CX - 120   # stem horizontal extent
BOWL_R = CX + 260                     # bowl right edge
STEM_BOT = CY + 330                   # stem bottom (full height)
# Counter (hole): inside the bowl, clear of every stroke.
CTR_L, CTR_R = STEM_R, BOWL_R - BAR
CTR_T, CTR_B = TOP + BAR, BOWL_BOT - BAR
CORNER = 120                          # background corner radius

S = SS
W = SIZE * S
corner = CORNER * S


def in_round_rect(x, y):
    m = corner
    if m <= x < W - m or m <= y < W - m:
        return x < W and y < W
    cx_ = m if x < m else W - m
    cy_ = m if y < m else W - m
    return (x - cx_) ** 2 + (y - cy_) ** 2 <= m * m


def in_p(x, y):
    """True if supersampled point (x, y) is inside the P glyph."""
    in_stem = STEM_L * S <= x < STEM_R * S and TOP * S <= y < STEM_BOT * S
    in_bowl = STEM_L * S <= x < BOWL_R * S and TOP * S <= y < BOWL_BOT * S
    in_counter = CTR_L * S <= x < CTR_R * S and CTR_T * S <= y < CTR_B * S
    return (in_stem or in_bowl) and not in_counter


def white_cov(px, py):
    """Fraction (0..1) of the SSxSS block covered by the P."""
    n = 0
    for oy in range(SS):
        y = py * SS + oy
        for ox in range(SS):
            x = px * SS + ox
            if in_p(x, y):
                n += 1
    return n / (SS * SS)


rows = []
for py in range(SIZE):
    row = bytearray()
    for px in range(SIZE):
        # supersampled background coverage for smooth outer corners
        bg = sum(
            1
            for oy in range(SS)
            for ox in range(SS)
            if in_round_rect(px * SS + ox, py * SS + oy)
        ) / (SS * SS)
        if bg <= 0:
            row += bytes((0, 0, 0, 0))
            continue
        w = white_cov(px, py)
        r = round(FG[0] * w + BG[0] * (1 - w))
        g = round(FG[1] * w + BG[1] * (1 - w))
        b = round(FG[2] * w + BG[2] * (1 - w))
        row += bytes((r, g, b, round(255 * bg)))
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
