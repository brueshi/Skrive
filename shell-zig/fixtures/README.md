# Parity corpus

The frozen oracle for the shell command contract. Each `<namespace>.jsonl`
file holds one `{ name, request, response }` per line: a request envelope
and the **normalized** response the contract requires. The goldens were
captured from the original reference shell; they now guard the Zig core,
which must reproduce every response byte-for-byte after normalization.

## Files

| File | Covers |
|---|---|
| `envelope.jsonl` | Dispatcher-level errors: `BAD_ENVELOPE` (malformed JSON, unknown field, bad version, non-object payload), `UNKNOWN_COMMAND`, `PAYLOAD_TOO_LARGE` |
| `fs.jsonl` | `fs:*` — read/write/create/rename/trash, plus `PATH_ESCAPE`, `ALREADY_EXISTS`, `INVALID_PAYLOAD` |
| `project.jsonl` | `project:snapshot`, `project:create`, plus their error cases |
| `persistence.jsonl` | `persistence:loadAppState` / `saveAppState` / `loadProjectState` / `revealUserData` |
| `sample-project/` | The checked-in project the corpus runs against (copied to a temp dir per run) |

The corpus deliberately covers only the namespaces the **Zig core**
reimplements. Host-implemented commands — `app:*`, `links:openExternal`,
`clipboard:*`, `updater:*`, `project:openDialog` — are the Swift/C++
host's responsibility, have OS side effects, and are not corpus-tested;
they get host-side tests in Stages 2/4/6. `diff:*` and `history:*` are
core but land in Stage 4 with their own fixtures (generated from
`native/diff/__test__` and a fixture git repo respectively).

Error codes reachable from the core namespaces are all represented;
`NOT_FOUND` / `NO_PROJECT` / `IO_ERROR` / `GIT_ERROR` / `INTERNAL` are
reserved in the contract but surface from history/host paths or remain
unmapped today (e.g. a missing-file read currently yields `INTERNAL`,
not `NOT_FOUND` — a deliberate non-change; the corpus captures current
behavior, it does not improve it).

## Determinism contract

Responses are normalized so a fixture reproduces on any machine and
matches a foreign dispatcher:

- The project root is an absolute temp path, different every run, so it
  is stored as `__SKRIVE_ROOT__` and substituted at the edges.
- `*Ms` fields (mtimes, timestamps) are normalized to `0`.
- Error `message` text is human prose that legitimately differs across
  implementations, so **parity is on `error.code`**; the message is
  normalized to `<message>`.
- Content hashes (SHA-256) are **kept** — they are the strong signal
  that two implementations read and wrote byte-equal content.

`PAYLOAD_TOO_LARGE` can't be stored literally (the request exceeds
32 MiB), so its fixture carries the sentinel `__SKRIVE_OVERSIZE__` and
the harness expands it to a real oversize request at dispatch time.

## Replay

```
bun run parity:check
```

Builds the Zig core and drives its `fixture_main` harness — a process that
reads one request-envelope JSON per line on stdin and writes one
response-envelope JSON per line on stdout — over a fresh copy of
`sample-project/`, substituting a real project root into each request and
diffing normalized responses against the goldens. Exits non-zero on any
mismatch. Point it at a different dispatcher with
`bun run parity:check -- --exec "<command>"`.

## Regenerate

The goldens are frozen. They were captured from the original reference
shell, which was removed when Electron was retired (SKR-106), so there is
no regenerator today: a command's contract changing intentionally means
updating the affected `<namespace>.jsonl` lines by hand — review the diff,
since it is the spec made concrete. A Zig-core-driven regenerator can be
re-added against `fixture_main` if that churn becomes frequent.
