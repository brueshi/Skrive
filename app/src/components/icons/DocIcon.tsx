import { IconDoc } from './IconDoc';
import { IconDocMarkdown } from './IconDocMarkdown';

// Markdown extensions, mirrored from the shell/model MARKDOWN_EXT. Kept local
// so the UI layer doesn't import the worker-side project model just to read a
// regex (matching the existing "duplicated for isolation" convention).
const MARKDOWN_EXT = /\.(md|markdown)$/i;

type Props = {
  path: string;
  size?: 16 | 24;
  className?: string;
};

// Picks the document glyph by file extension: the markdown (#) doc for
// .md/.markdown, the plain doc for everything else. The tree and tabs are
// markdown-only today, so the plain branch is dormant until other file types
// surface — the routing is correct, just not yet reachable.
export function DocIcon({ path, size = 24, className = '' }: Props) {
  const Doc = MARKDOWN_EXT.test(path) ? IconDocMarkdown : IconDoc;
  return <Doc size={size} className={className} />;
}
