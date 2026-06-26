// Durable anchors and the attachment seam (SKR-94 / SKR-96).
//
// The disk contract (planning/editor-surface-build-plan.md, "The disk contract"):
// the `.md` carries one invisible `<!-- sk:ID -->` comment ONLY on blocks that
// have a managed-layer attachment — pristine everywhere else. SQLite keys to
// those ids; inline anchors are `offset + fingerprint within block`. So
// reconciliation is always bounded to a single changed block, never a
// whole-document re-hunt.
//
// This module owns two things:
//   1. The comment grammar — parse an id out of a leading comment at load,
//      format one back at save. The serializer emits a comment for a block iff
//      the block is `durable` (see types.ts), which is the single source of
//      truth; the registry below is what will flip that flag when a feature
//      attaches to a block. Keeping the serializer reading the model flag (not a
//      global) is what keeps it pure.
//   2. The attachment registry SEAM — the by-id / by-range API the managed layer
//      (B2) plugs into. Defined here and exercised empty in Stage 1: no feature
//      attaches anything yet, and the round-trip corpus carries no comments.

import { BLOCK_ID_RE } from './id';

// A block-level anchor is just the block id. An inline anchor pins a position
// within a block by offset plus a fingerprint of nearby text, so it survives the
// block's bytes shifting without a document-global coordinate. Stage 1 defines
// the shapes; nothing populates them yet.
export type BlockAnchor = { blockId: string };
export type InlineAnchor = { blockId: string; offset: number; fingerprint: string };

const ANCHOR_RE = /^<!--\s*sk:([0-9a-z]+)\s*-->$/;

/** Parse a block id out of an anchor comment's value, or null if it is not one.
 *  Accepts the value with or without the surrounding `<!-- -->` (mdast `html`
 *  nodes include the delimiters; a bare comment body does not). */
export function parseAnchorComment(value: string): string | null {
  const trimmed = value.trim();
  const match = ANCHOR_RE.exec(trimmed);
  if (match && BLOCK_ID_RE.test(match[1]!)) return match[1]!;
  return null;
}

/** Format the durable anchor comment for a block id. */
export function formatAnchorComment(id: string): string {
  return `<!-- sk:${id} -->`;
}

/**
 * The attachment registry seam. Keyed by block id (block-level) — inline-range
 * attachments are a later refinement that key by {@link InlineAnchor}. Generic
 * over the attachment payload so the managed layer defines its own; Stage 1 only
 * proves the API exists and starts empty.
 */
export interface AttachmentRegistry<T = unknown> {
  has(blockId: string): boolean;
  get(blockId: string): T | undefined;
  attach(blockId: string, payload: T): void;
  detach(blockId: string): void;
  /** Block ids that currently carry an attachment. These are the ids that must
   *  serialize a durable comment. */
  attachedIds(): string[];
  readonly size: number;
}

/** A minimal in-memory attachment registry. The real managed layer (B2) replaces
 *  this with a SQLite-backed implementation behind the same interface. */
export class InMemoryAttachmentRegistry<T = unknown> implements AttachmentRegistry<T> {
  private readonly store = new Map<string, T>();

  has(blockId: string): boolean {
    return this.store.has(blockId);
  }
  get(blockId: string): T | undefined {
    return this.store.get(blockId);
  }
  attach(blockId: string, payload: T): void {
    this.store.set(blockId, payload);
  }
  detach(blockId: string): void {
    this.store.delete(blockId);
  }
  attachedIds(): string[] {
    return [...this.store.keys()];
  }
  get size(): number {
    return this.store.size;
  }
}
