# The fault model

Written before any engine code, because **"green under injected faults" only
means something against an enumerated list.** This document is the list. Its
typed counterpart is `src/fault.zig`; the two are kept in step.

## The invariant under test

> Every mutation the app has confirmed to the user as saved is present after
> replay, and no mutation is ever half-applied — fully present or fully absent.

This is the engine plan's §3 invariant, and it is a **non-loss** bar, not an
availability bar. That distinction is deliberate and was a decision, not a
reading: `docs/folio-schema-v1.md` §7 claims the engine "stores nothing
canonical", which would make recovery merely a convenience, while the engine
plan §2.1 says store loss costs history and stable identity. Per-block history
is store-only and cannot be reconstructed by re-scanning files, so the engine
plan is correct and the schema sentence is overreach. The harness asserts
non-loss.

## The five fault classes

### 1. Truncation

The log ends at an arbitrary byte offset mid-append. Models the ordinary
crash: process death, power loss, or a kill between `write` and completion.

**Recovery contract:** replay stops at the first record whose length or
checksum does not validate. Everything before it is intact and fully applied.
The partial record is discarded entirely.

**Injection:** exhaustive — a crash at *every* byte offset of the log at small
scale, seeded-sampled at large scale where exhaustive replay stops being
affordable.

### 2. Torn sector write

A partial sector (512B or 4K) reaches disk; the remainder does not. Distinct
from truncation because the surviving bytes need not be a prefix — a device may
commit a later sector while an earlier one is lost.

**Recovery contract:** the same as truncation from the reader's side (the
record fails validation and is discarded), but it must hold even when the
*length prefix* itself is the torn part, which is the case a naive
length-then-payload reader gets wrong.

**Injection:** drop or partially write sector-aligned spans within an in-flight
append.

### 3. Bit flip

A byte inside a structurally valid record is corrupted — correct length,
plausible framing, wrong content.

**Recovery contract:** CRC32 catches it. The record is treated as the end of
the valid log. A checksum that is computed but never verified on the read path
is the failure mode this class exists to catch.

**Injection:** flip bits at every field position of a record — length,
checksum, type tag, and payload — since each has a different failure signature.

### 4. Lost unsynced tail

Writes issued after the last successful `fsync` vanish entirely, **in any
subset**. Models the page-cache-loss case, where the OS acknowledged a write
that never reached stable storage.

**Recovery contract:** every mutation confirmed to the user as saved survives.
Mutations not yet confirmed may vanish. This is the class that tests whether
the confirmation boundary is drawn where the plan says it is — the save
indicator must reflect *confirmed* durability, not *submitted*.

**Injection:** discard an arbitrary subset of the writes issued since the last
fsync barrier.

### 5. Corrupt snapshot

The newest snapshot fails validation.

**Recovery contract:** fall back to the prior known-good snapshot plus the log
tail recorded after it. This is why the log is retained since the last
*known-good* snapshot rather than the last snapshot — a corrupt snapshot must
always be survivable.

**Injection:** truncate, bit-flip, and zero the newest snapshot; also the case
where the snapshot is valid but its recorded log position is not.

## What is not modeled

- **Byzantine storage** — a device that returns different bytes on successive
  reads of the same offset. Out of scope; CRC catches the single-read case and
  nothing here defends against an actively adversarial disk.
- **Filesystem-level loss** — the whole file or directory disappearing. That
  degrades to the engine plan's designed path: "just the files", rebuild the
  managed layer. Tested at integration, not here.
- **Concurrent writers.** The single-writer constraint makes this a design
  error rather than a fault to recover from. If a second process ever needs
  write access, this model is revisited before it ships.
