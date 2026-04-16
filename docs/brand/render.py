#!/usr/bin/env python3
"""Render the Skrive morse logo in every color variant as a 1024x1024 RGBA PNG.

Geometry follows Apple HIG: 824 visible tile, 185 px radius, 100 px margin.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

SIZE = 1024
INSET = 100
CORNER = 185
SCALE = 14
OFFSET = (SIZE - 48 * SCALE) // 2  # 176

LINEN = (244, 239, 230, 255)
ESPRESSO = (28, 25, 22, 255)
BRASS = (139, 106, 61, 255)

VARIANTS = {
    "light": {"tile": LINEN, "mark": ESPRESSO},
    "primary": {"tile": ESPRESSO, "mark": BRASS},
    "dark": {"tile": ESPRESSO, "mark": LINEN},
    "marketing": {"tile": BRASS, "mark": ESPRESSO},
}

# 48-unit coords. Dots are (cx, cy); dashes are (left, top).
DOTS = [
    (18, 9), (24, 9), (30, 9),              # S
    (24, 15),                                # K middle
    (15, 21), (33, 21),                      # R outer
    (21, 27), (27, 27),                      # I
    (12, 33), (18, 33), (24, 33),            # V dots
    (24, 39),                                # E
]
DASHES = [
    (10, 13), (28, 13),  # K outer
    (19, 19),            # R middle
    (28, 31),            # V final
]


def render(tile, mark):
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [INSET, INSET, SIZE - INSET - 1, SIZE - INSET - 1],
        radius=CORNER,
        fill=tile,
    )
    r = 2 * SCALE
    for cx, cy in DOTS:
        x = OFFSET + cx * SCALE
        y = OFFSET + cy * SCALE
        draw.ellipse([x - r, y - r, x + r, y + r], fill=mark)
    for left, top in DASHES:
        x = OFFSET + left * SCALE
        y = OFFSET + top * SCALE
        draw.rounded_rectangle(
            [x, y, x + 10 * SCALE, y + 4 * SCALE],
            radius=2 * SCALE,
            fill=mark,
        )
    return img


def main(out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, colors in VARIANTS.items():
        path = out_dir / f"skrive-logo-{name}-1024.png"
        render(colors["tile"], colors["mark"]).save(path, "PNG")
        print(f"wrote {path}")


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/skrive-logo")
    main(out)
