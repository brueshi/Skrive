import { IconDoc } from './IconDoc';
import { IconDocMarkdown } from './IconDocMarkdown';
import { IconDocText } from './IconDocText';
import { IconDocHtml } from './IconDocHtml';

// Extension families, mirrored from the shell/model regexes. Kept local so the
// UI layer doesn't import the worker-side project model just to read them
// (matching the existing "duplicated for isolation" convention).
const MARKDOWN_EXT = /\.(md|markdown)$/i;
const TEXT_EXT = /\.(txt|text)$/i;
const HTML_EXT = /\.(html|htm)$/i;

type Props = {
  path: string;
  size?: 16 | 24;
  className?: string;
};

// Picks the document glyph by file extension: the markdown (#) doc for
// .md/.markdown, the plain-text (TXT) doc for .txt/.text (SKR-204), the HTML
// (</>) doc for .html/.htm (SKR-205), and the generic plain doc for everything
// else.
export function DocIcon({ path, size = 24, className = '' }: Props) {
  const Doc = MARKDOWN_EXT.test(path)
    ? IconDocMarkdown
    : TEXT_EXT.test(path)
      ? IconDocText
      : HTML_EXT.test(path)
        ? IconDocHtml
        : IconDoc;
  return <Doc size={size} className={className} />;
}
