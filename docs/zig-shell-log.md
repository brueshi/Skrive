# Zig Shell Log

Session log per the master plan's working rules: one dated entry per
session — what was attempted, what passed, what blocked. Spec
clarifications and decision data live here so later stages (and the
results memo) don't have to reconstruct them.

---

## 2026-06-11 — Stage 0.1: envelope and dispatcher in the Electron shell

**Branch:** `refactor/ipc-envelope-dispatch` (off `main`).

**What was done.**
- Envelope types, channel constants, and the closed error-code set added
  to `shared/src/ipc-contracts.ts`.
- New `shell/src/main/dispatch.ts`: pure (Electron-free) registry +
  `dispatch(envelope)` / `dispatchJson(json)`, `IpcError` for coded
  handler errors, and an injected event sink (`setEventSink`/`emitEvent`).
  Electron wiring lives in `main/index.ts`: one `skrive:invoke` handle,
  events broadcast on `skrive:event`.
- All `ipcMain.handle` registrations re-routed through `registerCommand`
  across `ipc/{fs,project,diff,search,history,persistence,links,updater}.ts`
  and `main/index.ts`. Watcher and updater events now go through
  `emitEvent`; the flush-before-quit event does too (the renderer's
  `app:flush-complete` ack stays a raw `ipcRenderer.send` until Stage 2
  formalizes the handshake).
- Preload rewritten as a thin Electron transport: builds envelopes, one
  event demux, exposes the unchanged `SkriveIpc` surface. No `app/`
  changes.
- New `shell/__test__/dispatch.test.ts` (14 tests): success round-trip,
  UNKNOWN_COMMAND, PAYLOAD_TOO_LARGE, malformed JSON, unknown top-level
  field, version/id/payload shape violations, INTERNAL and coded error
  mapping, duplicate registration, event envelope shape.

**Decisions and spec clarifications (Part I envelope spec is silent on
these; none contradict it).**
- Envelopes cross the Electron channel as JSON strings, not
  structured-clone objects. Exact parity with string-marshaled native
  bridges, the 32 MiB cap is enforceable without parsing, and the
  Stage 0.6 corpus replays identical bytes against both dispatchers.
- `BAD_ENVELOPE` added to the closed error-code set for malformed
  JSON / envelope-shape violations (the spec names no code for these).
  Also reserved now: `INVALID_PAYLOAD`, `NOT_FOUND`, `ALREADY_EXISTS`,
  `NO_PROJECT`, `IO_ERROR`, `GIT_ERROR`, `INTERNAL`.
- Error responses for unparseable requests (or invalid `id`) carry
  `id: 0`, since no valid id exists to echo.
- Results are always objects per spec, so scalar-returning commands got
  named result fields (`app:version` -> `{ version }`, `fs:writeFile` ->
  `{ hash }`, `project:openDialog` -> `{ path }`, nullable
  `project:getManifest` -> `{ current }`). Domain-object results
  (manifest, FileContent, UpdaterStatus, ...) stay flat, matching the
  plan's own `project:snapshot` shape.
- Persistence command names aligned to the target table now
  (`appState:load` -> `persistence:loadAppState`, etc.) so the corpus
  isn't churned at the Stage 0 contract freeze. `search:*`/`linkGraph:*`
  keep their names; they leave the shell in 0.4.
- `project:openDialog` parents on `BrowserWindow.getFocusedWindow()`
  instead of the requesting webContents — the dispatcher has no sender
  identity by design (native bridges don't either). Single-window app;
  no observable change.
- Handler validation throws were converted to coded `IpcError`s
  (INVALID_PAYLOAD / NO_PROJECT / ALREADY_EXISTS / PATH_ESCAPE) while
  every registration was being touched anyway; messages preserved.
  Nothing in `app/src` matches on error message text (verified by grep).

**Gates.** `bun run typecheck` clean; shell suites 120/120 (10 files);
app suites 297/297 (18 files); `bun run start:build` clean.

**Incident (caught by the manual app-runs check).** First launch died
with `window.skrive` undefined: the preload's new value imports from
the `@skrive/shared` barrel dragged in the frontmatter module, whose
externalized `yaml` import survived bundling as `require("yaml")` — and
a sandboxed preload can require nothing but `electron`, so the preload
died before exposing the bridge. The previous preload only imported
types (erased at compile), which is why this never bit before. Fix:
the preload imports envelope constants from
`shared/src/ipc-contracts.ts` directly; that module has zero runtime
imports by design and must stay that way. Standing rule for every
future host: the renderer-facing transport layer must not import the
shared barrel's value surface. Verified post-fix: the built preload's
only external require is `electron`. Manual app-runs re-check after the
fix: pending (Joe).

**Blocked.** Nothing.

**Next.** Stage 0.2 — transport abstraction (`shared/src/bridge.ts`,
`createSkriveBridge(transport)`, preload becomes a thin transport, mock
transport + bridge tests).
