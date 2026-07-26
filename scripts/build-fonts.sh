#!/bin/bash
#
# Regenerate the bundled writing faces in app/src/assets/fonts.
#
# The committed .woff2 files are build output, not upstream originals, so
# this script is how they are reproduced or a new face is added. It needs
# network access and fontTools; it installs the latter into a throwaway
# virtualenv rather than adding a dependency to the repo.
#
#   bash scripts/build-fonts.sh
#
# Two treatments, chosen by whether the family declares a Reserved Font Name
# in its OFL copyright line:
#
#   no RFN  Instanced and subset. The optical-size axis is pinned to the
#           default reading size and weights are clamped to the range the
#           editor renders, then the face is cut down to Latin + Latin-Ext.
#           This produces a Modified Version under OFL clause 2.6, which is
#           only acceptable because no reserved name is attached.
#
#   RFN     Container conversion to woff2 and nothing else — every glyph and
#           every axis retained. This keeps the face Functionally Equivalent
#           to the original under OFL clause 2.8, which is what allows it to
#           keep its name. Do not instance or subset these; doing so would
#           oblige us to rename the family.
#
# Adding a face means: add it below, add its @font-face pair to
# app/src/assets/fonts/fonts.css, and add a registry entry in
# app/src/lib/typography-registry.ts. The test in
# app/__test__/lib/typography-registry.test.ts fails if any of the three
# drift apart.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$REPO/app/src/assets/fonts"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Pinned to the default editorFontSize. The editor exposes 14-22px, a band
# across which optical-size interpolation is close to imperceptible while
# costing 30-50% of every file that carries the axis.
OPSZ=17
WGHT="400:700"

LATIN='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD'
LATIN_EXT='U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF'

echo "Installing fontTools into a temporary virtualenv..."
python3 -m venv "$WORK/venv"
"$WORK/venv/bin/pip" install -q "fonttools[woff]" brotli
V="$WORK/venv/bin"

GF="https://raw.githubusercontent.com/google/fonts/main"

fetch() { # url dest
  # --fail matters: without it a 404 writes an HTML error page into a .ttf
  # and the failure only surfaces later as an unreadable font.
  if ! curl -fsSL --max-time 120 -o "$2" "$1"; then
    echo "Failed to download $1" >&2
    exit 1
  fi
}

subset_latin() { # src dest
  "$V/pyftsubset" "$1" --output-file="$2" --flavor=woff2 \
    --unicodes="$LATIN,$LATIN_EXT" --layout-features='*' --name-IDs='*' \
    --notdef-outline --drop-tables+=DSIG
}

convert_only() { # src dest
  "$V/pyftsubset" "$1" --output-file="$2" --flavor=woff2 \
    --unicodes='*' --glyphs='*' --layout-features='*' --name-IDs='*' \
    --notdef-outline --drop-tables+=DSIG
}

# dir|ofl_dir|has_opsz|upstream_file>output_name;...
# Semicolon separates the files: upstream variable-font names embed a comma
# in their axis list, so it cannot be the delimiter.
TRIMMED=(
  "literata|literata|yes|Literata[opsz,wght].ttf>literata-roman;Literata-Italic[opsz,wght].ttf>literata-italic"
  "newsreader|newsreader|yes|Newsreader[opsz,wght].ttf>newsreader-roman;Newsreader-Italic[opsz,wght].ttf>newsreader-italic"
  "source-serif-4|sourceserif4|yes|SourceSerif4[opsz,wght].ttf>source-serif-4-roman;SourceSerif4-Italic[opsz,wght].ttf>source-serif-4-italic"
  "inter|inter|yes|Inter[opsz,wght].ttf>inter-roman;Inter-Italic[opsz,wght].ttf>inter-italic"
  "eb-garamond|ebgaramond|no|EBGaramond[wght].ttf>eb-garamond-roman;EBGaramond-Italic[wght].ttf>eb-garamond-italic"
  "alegreya|alegreya|no|Alegreya[wght].ttf>alegreya-roman;Alegreya-Italic[wght].ttf>alegreya-italic"
  "atkinson-hyperlegible|atkinsonhyperlegiblenext|no|AtkinsonHyperlegibleNext[wght].ttf>atkinson-hyperlegible-roman;AtkinsonHyperlegibleNext-Italic[wght].ttf>atkinson-hyperlegible-italic"
  "jetbrains-mono|jetbrainsmono|no|JetBrainsMono[wght].ttf>jetbrains-mono-roman;JetBrainsMono-Italic[wght].ttf>jetbrains-mono-italic"
)

# Only the per-family directories are build output. fonts.css lives here too
# and is hand-written source — never clear $DEST itself.
mkdir -p "$DEST"

for entry in "${TRIMMED[@]}"; do
  IFS='|' read -r dir ofldir hasopsz pairs <<< "$entry"
  echo "Building $dir..."
  rm -rf "${DEST:?}/$dir"
  mkdir -p "$DEST/$dir"
  IFS=';' read -ra items <<< "$pairs"
  for item in "${items[@]}"; do
    upstream="${item%%>*}"
    name="${item##*>}"
    enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$upstream")
    fetch "$GF/ofl/$ofldir/$enc" "$WORK/$name.ttf"
    if [ "$hasopsz" = "yes" ]; then
      "$V/fonttools" varLib.instancer "$WORK/$name.ttf" "opsz=$OPSZ" "wght=$WGHT" \
        -o "$WORK/$name.inst.ttf" >/dev/null 2>&1
    else
      "$V/fonttools" varLib.instancer "$WORK/$name.ttf" "wght=$WGHT" \
        -o "$WORK/$name.inst.ttf" >/dev/null 2>&1
    fi
    subset_latin "$WORK/$name.inst.ttf" "$DEST/$dir/$name.woff2"
  done
  fetch "$GF/ofl/$ofldir/OFL.txt" "$DEST/$dir/OFL.txt"
done

# Reserved Font Name families below this line: container change only.
echo "Building source-sans-3 (Reserved Font Name: 'Source')..."
rm -rf "${DEST:?}/source-sans-3"
mkdir -p "$DEST/source-sans-3"
for pair in "SourceSans3[wght].ttf>source-sans-3-roman" "SourceSans3-Italic[wght].ttf>source-sans-3-italic"; do
  upstream="${pair%%>*}"; name="${pair##*>}"
  enc=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$upstream")
  fetch "$GF/ofl/sourcesans3/$enc" "$WORK/$name.ttf"
  convert_only "$WORK/$name.ttf" "$DEST/source-sans-3/$name.woff2"
done
fetch "$GF/ofl/sourcesans3/OFL.txt" "$DEST/source-sans-3/OFL.txt"

echo "Building monaspace-neon (Reserved Font Name: 'Monaspace')..."
rm -rf "${DEST:?}/monaspace-neon"
mkdir -p "$DEST/monaspace-neon"
MONO_VER="v1.400"
fetch "https://github.com/githubnext/monaspace/releases/download/$MONO_VER/monaspace-variable-$MONO_VER.zip" \
  "$WORK/monaspace.zip"
unzip -o -q "$WORK/monaspace.zip" -d "$WORK/monaspace"
convert_only "$WORK/monaspace/Variable Fonts/Monaspace Neon/Monaspace Neon Var.ttf" \
  "$DEST/monaspace-neon/monaspace-neon.woff2"
fetch "https://raw.githubusercontent.com/githubnext/monaspace/main/LICENSE" \
  "$DEST/monaspace-neon/OFL.txt"

echo
echo "Done. $(find "$DEST" -name '*.woff2' | wc -l | tr -d ' ') files, $(( $(find "$DEST" -name '*.woff2' -exec cat {} + | wc -c) / 1024 ))KB total."
