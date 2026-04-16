#!/usr/bin/env python3
"""Write one SVG master per color variant into docs/brand."""
import sys
from pathlib import Path

LINEN = "#f4efe6"
ESPRESSO = "#1c1916"
BRASS = "#8b6a3d"

VARIANTS = {
    "light": (LINEN, ESPRESSO),
    "primary": (ESPRESSO, BRASS),
    "dark": (ESPRESSO, LINEN),
    "marketing": (BRASS, ESPRESSO),
}

TEMPLATE = '''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="{tile}"/>
  <g transform="translate(176 176) scale(14)" fill="{mark}">
    <!-- S = ··· -->
    <circle cx="18" cy="9" r="2"/>
    <circle cx="24" cy="9" r="2"/>
    <circle cx="30" cy="9" r="2"/>
    <!-- K = -·- -->
    <rect x="10" y="13" width="10" height="4" rx="2"/>
    <circle cx="24" cy="15" r="2"/>
    <rect x="28" y="13" width="10" height="4" rx="2"/>
    <!-- R = ·-· -->
    <circle cx="15" cy="21" r="2"/>
    <rect x="19" y="19" width="10" height="4" rx="2"/>
    <circle cx="33" cy="21" r="2"/>
    <!-- I = ·· -->
    <circle cx="21" cy="27" r="2"/>
    <circle cx="27" cy="27" r="2"/>
    <!-- V = ···- -->
    <circle cx="12" cy="33" r="2"/>
    <circle cx="18" cy="33" r="2"/>
    <circle cx="24" cy="33" r="2"/>
    <rect x="28" y="31" width="10" height="4" rx="2"/>
    <!-- E = · -->
    <circle cx="24" cy="39" r="2"/>
  </g>
</svg>
'''


def main(out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    for name, (tile, mark) in VARIANTS.items():
        path = out_dir / f"skrive-logo-{name}.svg"
        path.write_text(TEMPLATE.format(tile=tile, mark=mark))
        print(f"wrote {path}")


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("/tmp/skrive-logo")
    main(out)
