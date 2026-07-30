#!/usr/bin/env bash
# Shell smoke check: does the real thing come up and work?
#
#   bun run smoke:macos
#
# Every other gate runs the renderer in Chromium, where window.skrive is a mock
# and window.skrive.spell does not exist at all — so the entire host path is
# invisible to them. Two defects shipped past four green gates in one session:
# the host SIGTRAPed on launch on Swift-6 executor-isolation checks inside an
# NSSpellChecker completion, and a Vite dep race blank-screened the window. Both
# were found by a human opening the app.
#
# This is deliberately NOT a second editor suite. No UI automation, no typing,
# no screenshots. It answers one question — is the real app alive and do its
# round trips work — and it has to stay fast and dumb or it will rot.
#
# The host already carried most of this: SKRIVE_DIAG has long injected a
# self-test that round-trips app:version, project:snapshot and friends against
# the real bridge and prints `SELFTEST {json}`. What was missing was a judge.
# This script is that judge, plus the crash/log evidence the in-page test cannot
# see from inside the page.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEV_URL="${SKRIVE_DEV_URL:-http://localhost:5173}"
DEPS_DIR="$REPO_ROOT/app/node_modules/.vite/deps"
CRASHES_DIR="$HOME/Library/Application Support/Skrive/crashes"
REPORTS_DIR="$HOME/Library/Logs/DiagnosticReports"
RUN_LOG="$(mktemp -t skrive-smoke)"
TIMEOUT_SECS="${SKRIVE_SMOKE_TIMEOUT:-60}"
# How long to allow for the process to exit AFTER it has reported.
EXIT_GRACE_SECS="${SKRIVE_SMOKE_EXIT_GRACE:-6}"

# shellcheck source=./wait-for-vite.sh
source "$SCRIPT_DIR/wait-for-vite.sh"

fail_count=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; fail_count=$(( fail_count + 1 )); }
info() { printf '      %s\n' "$1"; }
# A known defect that must stay VISIBLE without failing every run. Used only
# where the cause is understood and tracked; anything unexplained fails.
warn() { printf 'WARN  %s\n' "$1"; }

cleanup() {
  [[ -n "${VITE_PID:-}" ]] && kill "$VITE_PID" 2>/dev/null
  [[ -n "${HOST_PID:-}" ]] && kill "$HOST_PID" 2>/dev/null
  return 0
}
trap cleanup EXIT

echo "==> building native host (debug)"
if ! bash "$SCRIPT_DIR/build-macos.sh" debug >/dev/null 2>&1; then
  echo "FAIL  host build" >&2
  bash "$SCRIPT_DIR/build-macos.sh" debug 2>&1 | tail -30 >&2
  exit 1
fi

# Reuse a dev server that is already up rather than starting a second one. The
# port is strict (vite.config.ts sets strictPort so a stray 5174 can't silently
# become the real server), so spawning unconditionally would just fail against a
# developer's running session — and killing theirs to run a check is rude.
if curl -sf -o /dev/null "$DEV_URL"; then
  echo "==> reusing the Vite server already on $DEV_URL"
else
  echo "==> starting Vite"
  ( cd "$REPO_ROOT" && bun run dev >/dev/null 2>&1 ) &
  VITE_PID=$!
fi

# Not just "does it answer" — launching on the first 200 races dep pre-bundling
# and blank-screens the window, which is one of the two defects this exists for.
echo "==> waiting for Vite (server + dep optimization)"
if ! wait_for_vite "$DEV_URL" "$DEPS_DIR"; then
  echo "FAIL  vite never became ready" >&2
  exit 1
fi

# Baseline the evidence the in-page self-test cannot see. A crash report or a
# renderer error can land without any assertion noticing, so the run is bracketed
# by before/after snapshots rather than trusting the page to report its own death.
reports_before="$(ls "$REPORTS_DIR"/SkriveShell-*.ips 2>/dev/null | wc -l | tr -d ' ')"
renderer_log_before=0
[[ -f "$CRASHES_DIR/renderer.log" ]] &&
  renderer_log_before="$(wc -c < "$CRASHES_DIR/renderer.log" | tr -d ' ')"

echo "==> launching host (SKRIVE_SMOKE=1)"
BIN="$SCRIPT_DIR/macos/.build/Skrive.app/Contents/MacOS/SkriveShell"  # noscan: build path, not a credential — its mixed case trips the entropy heuristic
SKRIVE_SMOKE=1 SKRIVE_DEV_URL="$DEV_URL" "$BIN" >"$RUN_LOG" 2>&1 &
HOST_PID=$!

# The host quits itself once the self-test reports, so waiting on the process IS
# waiting for the run — with a backstop for a host that hangs before reporting.
# Two different deadlines, because the two hangs mean different things. Waiting
# for the REPORT gets the full timeout: a renderer that is slow to boot is still
# booting. Waiting for the EXIT afterwards gets a few seconds, because the known
# quit defect would otherwise burn the whole budget on every run and turn a
# sub-minute check into a minute and a half of nothing happening.
waited=0
hung_after_report=0
reported=0
grace=0
while kill -0 "$HOST_PID" 2>/dev/null; do
  if (( ! reported )) && grep -q '^\[diag\] SELFTEST ' "$RUN_LOG" 2>/dev/null; then
    reported=1
  fi
  if (( reported )); then
    if (( grace >= EXIT_GRACE_SECS )); then
      hung_after_report=1
      kill -9 "$HOST_PID" 2>/dev/null
      break
    fi
    grace=$(( grace + 1 ))
  elif (( waited >= TIMEOUT_SECS )); then
    fail "host did not finish within ${TIMEOUT_SECS}s and never reported"
    info "the renderer never reached the self-test — a real liveness failure"
    kill -9 "$HOST_PID" 2>/dev/null
    break
  fi
  sleep 1
  waited=$(( waited + 1 ))
done
wait "$HOST_PID" 2>/dev/null
host_exit=$?
HOST_PID=""

echo
echo "==> results"

# 133 = SIGTRAP, the Swift-6 runtime trap that killed the host twice; 143 =
# SIGTERM. Naming them beats printing a bare number nobody can decode.
case "$host_exit" in
  0)   pass "host exited cleanly (0)" ;;
  133) fail "host SIGTRAPed (133) — a Swift runtime trap, likely an isolation assertion" ;;
  *)
    if (( hung_after_report )); then
      warn "host had to be killed ($host_exit) — see the clean-quit result below"
    else
      fail "host exited $host_exit"
    fi
    ;;
esac

selftest="$(grep -m1 '^\[diag\] SELFTEST ' "$RUN_LOG" | sed 's/^\[diag\] SELFTEST //')"
if [[ -z "$selftest" ]]; then
  fail "no SELFTEST report — the renderer never reached the probe"
  info "last host output:"
  tail -20 "$RUN_LOG" | sed 's/^/      /'
else
  # The judge. Each rule names what its failure would MEAN, because a smoke
  # check that prints "assertion 4 failed" teaches nobody anything.
  while IFS=$'\t' read -r verdict label detail; do
    case "$verdict" in
      pass) pass "$label" ;;
      fail) fail "$label"; [[ -n "$detail" ]] && info "$detail" ;;
      info) info "$label" ;;
    esac
  done < <(printf '%s' "$selftest" | python3 "$SCRIPT_DIR/smoke-judge.py")
fi

# Flush ack: the pre-quit flush logs its duration. Hitting the 2s backstop means
# the renderer never answered — the app still quits, but it quit by giving up.
flush_ms="$(grep -o 'pre-quit flush took [0-9]* ms' "$RUN_LOG" | grep -o '[0-9]*' | head -1)"
# KNOWN DEFECT, reported but not gating. On a shell-launched run with no
# document open, applicationShouldTerminate runs and beginFlush emits
# app:flush-before-quit, but neither the renderer's ack nor beginFlush's own 2s
# backstop ever fires — both are serviced by the main run loop, which is starved
# once .terminateLater is returned — so the process never exits. Tracked
# separately; the trace stays printed here so it cannot be quietly forgotten.
if [[ -z "$flush_ms" ]]; then
  warn "no pre-quit flush recorded — the quit did not complete (known defect)"
  info "applicationShouldTerminate ran, but the flush never finished"
elif (( flush_ms >= 2000 )); then
  warn "pre-quit flush hit the ${flush_ms}ms backstop — the renderer never acked"
else
  pass "clean quit (flush acked in ${flush_ms}ms)"
fi

# ReportCrash writes the .ips asynchronously, so a crash detected by the exit
# code above may not have a report on disk yet — this check catches traps that
# leave the process alive or that happen after the run, and is a supplement to
# the exit code, never a substitute for it.
reports_after="$(ls "$REPORTS_DIR"/SkriveShell-*.ips 2>/dev/null | wc -l | tr -d ' ')"
if (( reports_after > reports_before )); then
  fail "$(( reports_after - reports_before )) new crash report(s) during the run"
  info "$(ls -t "$REPORTS_DIR"/SkriveShell-*.ips 2>/dev/null | head -1)"
else
  pass "no new crash reports"
fi

renderer_log_after=0
[[ -f "$CRASHES_DIR/renderer.log" ]] &&
  renderer_log_after="$(wc -c < "$CRASHES_DIR/renderer.log" | tr -d ' ')"
if (( renderer_log_after > renderer_log_before )); then
  fail "renderer.log grew during the run (an uncaught renderer error)"
  info "$(tail -3 "$CRASHES_DIR/renderer.log")"
else
  pass "renderer.log unchanged"
fi

echo
if (( fail_count > 0 )); then
  echo "SMOKE FAILED ($fail_count)"
  echo "full host output: $RUN_LOG"
  exit 1
fi
echo "SMOKE PASSED"
rm -f "$RUN_LOG"
