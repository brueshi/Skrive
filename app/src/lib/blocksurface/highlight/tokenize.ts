// The tokenizer: text + language -> flat, non-overlapping token spans. Imported
// by both the Worker (where it runs) and the unit test (where it is exercised
// without a worker). Prism is a pure regex tokenizer here — `Prism.tokenize`
// touches no DOM — which is exactly what lets it run off the main thread.
//
// The launch grammar set is bundled statically. This chunk is only ever loaded by
// the highlight worker, so it never touches the main thread's critical path; a
// lazily-loaded, pluggable grammar set is a later refinement (the SKR-110 registry
// seams). Grammars are imported in dependency order — a Prism component assumes
// the grammars it extends are already registered on the global `Prism`.

import './prism-setup';
import Prism from 'prismjs';

// markup / css / clike / javascript ship in the default `prismjs` build; the rest
// are pulled in explicitly, each after the grammar it extends.
import 'prismjs/components/prism-typescript'; // extends javascript
import 'prismjs/components/prism-jsx'; // extends markup + javascript
import 'prismjs/components/prism-tsx'; // extends jsx + typescript
import 'prismjs/components/prism-python';
import 'prismjs/components/prism-c'; // extends clike
import 'prismjs/components/prism-cpp'; // extends c
import 'prismjs/components/prism-go'; // extends clike
import 'prismjs/components/prism-rust';
import 'prismjs/components/prism-java'; // extends clike
import 'prismjs/components/prism-csharp'; // extends clike
import 'prismjs/components/prism-ruby'; // extends clike
import 'prismjs/components/prism-kotlin'; // extends clike
import 'prismjs/components/prism-dart'; // extends clike
import 'prismjs/components/prism-scala'; // extends java
import 'prismjs/components/prism-objectivec'; // extends c
import 'prismjs/components/prism-swift';
import 'prismjs/components/prism-lua';
import 'prismjs/components/prism-r';
import 'prismjs/components/prism-elixir';
import 'prismjs/components/prism-haskell';
import 'prismjs/components/prism-perl';
import 'prismjs/components/prism-json';
import 'prismjs/components/prism-yaml';
import 'prismjs/components/prism-toml';
import 'prismjs/components/prism-ini';
import 'prismjs/components/prism-bash';
import 'prismjs/components/prism-powershell';
import 'prismjs/components/prism-sql';
import 'prismjs/components/prism-graphql';
import 'prismjs/components/prism-docker';
import 'prismjs/components/prism-diff';
import 'prismjs/components/prism-zig';
import 'prismjs/components/prism-markup-templating'; // extends markup; required by php
import 'prismjs/components/prism-php'; // extends markup-templating
import 'prismjs/components/prism-markdown'; // extends markup

import type { HighlightToken } from './highlight-worker-protocol';
import { resolveLanguage } from './languages';

type PrismNode = string | Prism.Token;

/** Flatten Prism's (possibly nested) token tree into non-overlapping spans, each
 *  character carrying the type of its nearest enclosing token. Plain strings with
 *  no enclosing token emit nothing (they render in the default text colour). The
 *  running `pos` tracks raw string offset so spans line up with `text.slice`. */
function flatten(nodes: PrismNode[], type: string, pos: number, out: HighlightToken[]): number {
  for (const node of nodes) {
    if (typeof node === 'string') {
      if (node.length > 0 && type !== '') out.push({ start: pos, end: pos + node.length, type });
      pos += node.length;
      continue;
    }
    const content = node.content;
    if (typeof content === 'string') {
      if (content.length > 0) out.push({ start: pos, end: pos + content.length, type: node.type });
      pos += content.length;
    } else if (Array.isArray(content)) {
      pos = flatten(content as PrismNode[], node.type, pos, out);
    } else {
      pos = flatten([content], node.type, pos, out);
    }
  }
  return pos;
}

/** Tokenize `text` as `lang` into flat spans. Returns [] for an unknown language
 *  or empty text — the caller treats that as "no highlighting for this block". */
export function tokenizeToRanges(text: string, lang: string): HighlightToken[] {
  if (text.length === 0) return [];
  const name = resolveLanguage(lang);
  if (name === null) return [];
  const grammar = Prism.languages[name];
  if (!grammar) return [];
  const out: HighlightToken[] = [];
  flatten(Prism.tokenize(text, grammar) as PrismNode[], '', 0, out);
  return out;
}
