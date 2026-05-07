// Forward + back link tables for the entire project. Mirrors
// `src-tauri/src/link_graph.rs::LinkGraph`. Keys are project-relative
// paths in forward-slash form; wiki edges are tracked in `forward`
// only — backward index is keyed by resolved relative paths, so wiki
// targets (which aren't resolved at extraction time) don't contribute.
//
// `set_links` keeps both indexes in sync transparently. Callers
// re-extract a source's edges and hand the new list in; the graph
// figures out what to add and what to drop from `backward`.

import type { Edge } from '@skrive/shared';

export class LinkGraph {
  private forwardMap = new Map<string, Edge[]>();
  /** Target relative path → set of source relative paths. */
  private backwardMap = new Map<string, Set<string>>();

  setLinks(source: string, edges: Edge[]): void {
    const oldTargets = relativeTargets(this.forwardMap.get(source) ?? []);
    const newTargets = relativeTargets(edges);

    for (const dropped of difference(oldTargets, newTargets)) {
      const set = this.backwardMap.get(dropped);
      if (!set) continue;
      set.delete(source);
      if (set.size === 0) this.backwardMap.delete(dropped);
    }
    for (const added of difference(newTargets, oldTargets)) {
      let set = this.backwardMap.get(added);
      if (!set) {
        set = new Set();
        this.backwardMap.set(added, set);
      }
      set.add(source);
    }

    this.forwardMap.set(source, edges);
  }

  /** Drop every edge originating at `source`. Used on file delete or
   *  rename-away. */
  forget(source: string): void {
    const old = this.forwardMap.get(source);
    if (!old) return;
    this.forwardMap.delete(source);
    for (const edge of old) {
      if (edge.target.kind !== 'relative') continue;
      const set = this.backwardMap.get(edge.target.path);
      if (!set) continue;
      set.delete(source);
      if (set.size === 0) this.backwardMap.delete(edge.target.path);
    }
  }

  outgoing(source: string): Edge[] | undefined {
    return this.forwardMap.get(source);
  }

  /** Source paths that link to `target`. Returns a fresh array (sorted
   *  for stable UI) — callers don't need a Set. */
  incoming(target: string): string[] {
    const set = this.backwardMap.get(target);
    if (!set) return [];
    return [...set].sort();
  }

  /** Iterate every (source, edges) pair in source-sorted order. */
  *iter(): IterableIterator<[string, Edge[]]> {
    const keys = [...this.forwardMap.keys()].sort();
    for (const k of keys) yield [k, this.forwardMap.get(k)!];
  }

  sourceCount(): number {
    return this.forwardMap.size;
  }
}

function relativeTargets(edges: Edge[]): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) {
    if (edge.target.kind === 'relative') out.add(edge.target.path);
  }
  return out;
}

function difference<T>(a: Set<T>, b: Set<T>): T[] {
  const out: T[] = [];
  for (const v of a) if (!b.has(v)) out.push(v);
  return out;
}
