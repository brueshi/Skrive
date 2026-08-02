import { IconDoc } from './IconDoc';
import { IconDocMarkdown } from './IconDocMarkdown';
import { IconDocText } from './IconDocText';
import { IconDocHtml } from './IconDocHtml';
import { HTML_EXT, MARKDOWN_EXT, TEXT_EXT } from '../../lib/doc-types';

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
