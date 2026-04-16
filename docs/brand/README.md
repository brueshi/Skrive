# Skrive brand assets

The Skrive mark is the word itself, encoded in International Morse: `··· -·- ·-· ·· ···- ·`. Each letter occupies one row on a 48-unit grid inside an Apple HIG–compliant tile (1024 canvas, 824 visible area, 185 px continuous-curve radius).

## Variants

Every variant is provided as an SVG master and a 1024 px RGBA PNG. Transparent corners mean the dock and browser chrome render the tile cleanly without a halo.

| Variant | Tile | Mark | Use |
| --- | --- | --- | --- |
| `skrive-logo-light` | `#f4efe6` linen | `#1c1916` espresso | App icon, default favicon, light surfaces |
| `skrive-logo-primary` | `#1c1916` espresso | `#8b6a3d` brass | Hero surfaces, splash, marketing signature |
| `skrive-logo-dark` | `#1c1916` espresso | `#f4efe6` linen | Dark mode, low-light dock, video chrome |
| `skrive-logo-marketing` | `#8b6a3d` brass | `#1c1916` espresso | Campaign takeovers, partner co-brand |

The app icon currently shipped to Tauri (`src-tauri/icons/`) and the web favicon (`static/favicon.png`) use the **light** variant.

## Regenerating

```bash
# PNGs — draws directly with PIL so alpha stays intact
python3 docs/brand/render.py docs/brand

# SVG masters
python3 docs/brand/gen_svgs.py docs/brand
```

To push a different variant to the Tauri binary, point `tauri icon` at the chosen 1024 PNG:

```bash
npx tauri icon docs/brand/skrive-logo-primary-1024.png
```

Delete `src-tauri/target/debug/skrive` and touch `src-tauri/build.rs` so the next `tauri dev` re-embeds the new icon.
