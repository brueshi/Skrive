// The clipboard grid: how a rectangle of cells leaves the table and how a grid
// from elsewhere (a spreadsheet, another table) comes in. The host owns the
// clipboard events and the cells' text; this codec owns only the grid shape.
// Encoding writes both flavors spreadsheets read: tab-separated text and an
// HTML table. Decoding prefers the HTML table when one is present (it keeps
// cell boundaries that tabs and newlines inside a cell would blur) and falls
// back to tab-separated text. A payload without a grid shape decodes to null,
// so the host's ordinary paste keeps everything that is not a grid.

import type { CellPayload, GridCodec } from './contract';

/** Quote a tab-separated field the way spreadsheets do: only when it holds a
 *  tab, a line break, or a quote, doubling the quotes inside. */
function tsvField(text: string): string {
  return /[\t\r\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Parse tab-separated text into rows, honoring quoted fields (a quoted field
 *  may span lines and hold tabs; a doubled quote is one quote). A trailing line
 *  break, which every spreadsheet appends, does not make an empty last row. */
export function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const endField = (): void => {
    row.push(field);
    field = '';
  };
  const endRow = (): void => {
    endField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === '\t') {
      endField();
      i++;
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      endRow();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** The rows of the first `<table>` in an HTML payload, as trimmed cell text,
 *  or null when there is no table or it holds no cells. Needs a DOM parser. */
function parseHtmlTable(html: string): string[][] | null {
  if (typeof DOMParser === 'undefined' || !/<table[\s>]/i.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  if (!table) return null;
  const rows: string[][] = [];
  for (const tr of Array.from(table.querySelectorAll('tr'))) {
    // Only this table's rows: a nested table (rare in a paste) stays inside its cell.
    if (tr.closest('table') !== table) continue;
    const cells = Array.from(tr.children).filter((el) => el.tagName === 'TD' || el.tagName === 'TH');
    if (cells.length === 0) continue;
    rows.push(cells.map((cell) => cellText(cell)));
  }
  return rows.length > 0 ? rows : null;
}

/** A cell's text with its line breaks kept: `<br>` and block children become
 *  newlines, then the whitespace a pretty-printed table adds is trimmed. */
function cellText(cell: Element): string {
  const clone = cell.cloneNode(true) as Element;
  for (const br of Array.from(clone.querySelectorAll('br'))) br.replaceWith('\n');
  for (const block of Array.from(clone.querySelectorAll('p, div, li'))) {
    if (block.nextSibling) block.append('\n');
  }
  return (clone.textContent ?? '').replace(/ /g, ' ').replace(/[ \t]*\n[ \t]*/g, '\n').trim();
}

/** Pad ragged rows to the widest, so a grid is always rectangular. */
function rectangular(rows: string[][]): string[][] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  return rows.map((r) => (r.length === width ? r : [...r, ...Array.from({ length: width - r.length }, () => '')]));
}

export const gridCodec: GridCodec = {
  encode(grid: ReadonlyArray<ReadonlyArray<CellPayload>>) {
    const text = grid.map((row) => row.map((cell) => tsvField(cell.text)).join('\t')).join('\n');
    const html = `<table><tbody>${grid
      .map((row) => `<tr>${row.map((cell) => `<td>${cell.html || escapeHtml(cell.text)}</td>`).join('')}</tr>`)
      .join('')}</tbody></table>`;
    return { text, html };
  },

  decode(payload) {
    const fromHtml = payload.html ? parseHtmlTable(payload.html) : null;
    if (fromHtml) return rectangular(fromHtml);
    const text = payload.text ?? '';
    // Tab-separated text is a grid only when a tab is present: lines alone are
    // paragraphs, and the host's ordinary paste owns those.
    if (!text.includes('\t')) return null;
    const rows = parseTsv(text);
    return rows.length > 0 ? rectangular(rows) : null;
  }
};
