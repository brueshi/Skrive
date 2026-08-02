#!/usr/bin/env bash
# Wait until the Vite dev server is genuinely ready to be loaded by the host.
#
# "Responds to curl" is NOT ready, and treating it as ready is a real bug that
# blank-screens the window. The server binds and serves index.html long before it
# has finished pre-bundling dependencies. If the host loads the page during that
# window, it fetches a module graph whose chunk files are still being rewritten;
# because Vite keeps the same `browserHash` across that rewrite, the page never
# refetches them and simply fails, leaving an empty window and a Vite log full of
#
#     The file does not exist at ".../deps/chunk-XXXX.js"
#
# The tell-tale afterwards is a `browserHash` in deps/_metadata.json that matches
# what the page requested while the chunk files it names are absent. A blind
# `rm -rf .vite` and restart does not fix it, because the race simply reruns.
#
# So readiness is three things, in order:
#   1. the server answers at all,
#   2. it has been WARMED — dep optimization is triggered by crawling the module
#      graph, so nothing is pre-bundled until someone actually asks for the entry
#      module,
#   3. the deps directory has stopped changing.
#
# Sourced by dev-macos.sh and the smoke check so the two cannot drift apart.

# wait_for_vite <url> <deps_dir> [timeout_seconds]
wait_for_vite() {
  local url="$1"
  local deps_dir="$2"
  local timeout="${3:-90}"
  local deadline=$(( SECONDS + timeout ))

  # 1. The server answers.
  until curl -sf -o /dev/null "$url"; do
    if (( SECONDS > deadline )); then
      echo "wait-for-vite: timed out waiting for $url" >&2
      return 1
    fi
    sleep 0.3
  done

  # 2. Warm it. Requesting the entry module is what makes Vite crawl the graph
  #    and start pre-bundling; without this the deps directory can sit empty and
  #    "stable" forever, and we would declare victory on an unoptimized server.
  curl -sf -o /dev/null "$url" || true
  curl -sf -o /dev/null "$url/src/main.tsx" || true

  # 3. Poll until the deps directory settles. Stability is measured as an
  #    unchanged (file count, metadata mtime) pair across consecutive samples —
  #    the count alone can pause mid-write while a chunk is being replaced.
  local stable=0 last=""
  while (( stable < 4 )); do
    if (( SECONDS > deadline )); then
      echo "wait-for-vite: dep optimization did not settle within ${timeout}s" >&2
      echo "wait-for-vite: last sample '$last' in $deps_dir" >&2
      return 1
    fi
    local count meta now
    # `|| true` because the deps directory legitimately does not exist for part
    # of this wait: Vite DELETES and recreates it when it optimizes from cold.
    # Without this, `ls` fails, pipefail propagates that through the assignment,
    # and the sourcing script's `set -e` kills the whole dev loop mid-wait — with
    # no message, since neither timeout branch below is ever reached. A cleared
    # cache is a routine thing to do, and it must not take the dev script down.
    count="$( { ls "$deps_dir" 2>/dev/null || true; } | wc -l | tr -d ' ')"
    meta="$(stat -f %m "$deps_dir/_metadata.json" 2>/dev/null || echo none)"
    now="$count:$meta"
    # A server with no metadata yet has not finished its first optimize pass.
    if [[ "$now" == "$last" && "$meta" != "none" && "$count" != "0" ]]; then
      stable=$(( stable + 1 ))
    else
      stable=0
    fi
    last="$now"
    sleep 0.25
  done
}
