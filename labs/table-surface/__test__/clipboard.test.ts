// @vitest-environment jsdom
// The clipboard grid codec against payloads shaped like what the spreadsheets a
// writer pastes from actually put on the clipboard: Numbers (a styled HTML
// table with a paragraph per cell), Google Sheets (an HTML table wrapped in its
// origin tag, tab-separated text alongside), and Excel (an Office fragment with
// classed cells). Shaped like, not captured from: the shapes are what the
// decoder keys on, and each fixture holds the quirk that matters.

import { describe, expect, it } from 'vitest';
import { gridCodec, parseTsv } from '../src';

const NUMBERS_HTML = `<meta charset="UTF-8"><table style="border-collapse: collapse; font-family: Helvetica Neue;">
<tbody>
<tr><td style="padding: 2px 4px;"><p style="margin: 0px;"><span>Item</span></p></td><td style="padding: 2px 4px;"><p style="margin: 0px;">Qty</p></td></tr>
<tr><td><p>Apples</p></td><td><p>3</p></td></tr>
<tr><td><p>Pears, red</p></td><td><p>12</p></td></tr>
</tbody>
</table>`;
const NUMBERS_TEXT = 'Item\tQty\nApples\t3\nPears, red\t12\n';

const SHEETS_HTML = `<meta charset='utf-8'><google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style><table xmlns="http://www.w3.org/1999/xhtml" cellspacing="0" cellpadding="0" dir="ltr" border="1" style="table-layout:fixed;font-size:10pt;font-family:Arial;width:0px;border-collapse:collapse;border:none" data-sheets-root="1"><colgroup><col width="100"/><col width="100"/></colgroup><tbody><tr style="height:21px;"><td style="overflow:hidden;padding:2px 3px 2px 3px;vertical-align:bottom;" data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;Name&quot;}">Name</td><td data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;Note&quot;}">Note</td></tr><tr style="height:21px;"><td>Ada</td><td data-sheets-value="{&quot;1&quot;:2,&quot;2&quot;:&quot;line one\\nline two&quot;}">line one<br/>line two</td></tr></tbody></table></google-sheets-html-origin>`;
const SHEETS_TEXT = 'Name\tNote\nAda\t"line one\nline two"\n';

const EXCEL_HTML = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta http-equiv=Content-Type content="text/html; charset=utf-8"><style>td{mso-number-format:General;} .xl65{font-weight:700;}</style></head><body link="#0563C1" vlink="#954F72"><table border=0 cellpadding=0 cellspacing=0 width=128 style='border-collapse:collapse;width:96pt'><!--StartFragment--><col width=64 span=2 style='width:48pt'><tr height=20 style='height:15.0pt'><td height=20 class=xl65 width=64 style='height:15.0pt;width:48pt'>A</td><td class=xl65 width=64 style='width:48pt'>B</td></tr><tr height=20 style='height:15.0pt'><td height=20 style='height:15.0pt' align=right>1</td><td align=right>2</td></tr><!--EndFragment--></table></body></html>`;
const EXCEL_TEXT = 'A\tB\r\n1\t2\r\n';

describe('decode', () => {
  it('reads a Numbers table, one paragraph per cell', () => {
    expect(gridCodec.decode({ html: NUMBERS_HTML, text: NUMBERS_TEXT })).toEqual([
      ['Item', 'Qty'],
      ['Apples', '3'],
      ['Pears, red', '12']
    ]);
  });

  it('reads a Sheets table, keeping a line break inside a cell', () => {
    expect(gridCodec.decode({ html: SHEETS_HTML, text: SHEETS_TEXT })).toEqual([
      ['Name', 'Note'],
      ['Ada', 'line one\nline two']
    ]);
  });

  it('reads an Excel fragment with Windows line ends in the text flavor', () => {
    expect(gridCodec.decode({ html: EXCEL_HTML, text: EXCEL_TEXT })).toEqual([
      ['A', 'B'],
      ['1', '2']
    ]);
    expect(gridCodec.decode({ text: EXCEL_TEXT })).toEqual([
      ['A', 'B'],
      ['1', '2']
    ]);
  });

  it('falls back to tab-separated text, honoring quoted fields', () => {
    expect(gridCodec.decode({ text: SHEETS_TEXT })).toEqual([
      ['Name', 'Note'],
      ['Ada', 'line one\nline two']
    ]);
    expect(parseTsv('a\t"say ""hi"""\tc')).toEqual([['a', 'say "hi"', 'c']]);
  });

  it('pads ragged rows to a rectangle', () => {
    expect(gridCodec.decode({ text: 'a\tb\tc\nd' })).toEqual([
      ['a', 'b', 'c'],
      ['d', '', '']
    ]);
  });

  it('is null for anything that is not a grid', () => {
    expect(gridCodec.decode({ text: 'just a sentence' })).toBeNull();
    expect(gridCodec.decode({ text: 'one line\nanother line' })).toBeNull();
    expect(gridCodec.decode({ html: '<p>prose</p>', text: 'prose' })).toBeNull();
    expect(gridCodec.decode({ html: '<table></table>', text: '' })).toBeNull();
    expect(gridCodec.decode({})).toBeNull();
  });

  it('a one-cell table still decodes; the host decides whether that is a paste of text', () => {
    expect(gridCodec.decode({ html: '<table><tr><td>only</td></tr></table>' })).toEqual([['only']]);
  });
});

describe('encode', () => {
  const grid = [
    [
      { text: 'a', html: 'a' },
      { text: 'b & c', html: 'b &amp; <em>c</em>' }
    ],
    [
      { text: 'two\nlines', html: 'two<br>lines' },
      { text: '', html: '' }
    ]
  ];

  it('writes tab-separated rows, quoting a cell that holds a line break', () => {
    expect(gridCodec.encode(grid).text).toBe('a\tb & c\n"two\nlines"\t');
  });

  it('writes an HTML table carrying each cell\'s own markup', () => {
    expect(gridCodec.encode(grid).html).toBe(
      '<table><tbody><tr><td>a</td><td>b &amp; <em>c</em></td></tr><tr><td>two<br>lines</td><td></td></tr></tbody></table>'
    );
  });

  it('round-trips through decode', () => {
    const { text, html } = gridCodec.encode(grid);
    expect(gridCodec.decode({ text, html })).toEqual([
      ['a', 'b & c'],
      ['two\nlines', '']
    ]);
    expect(gridCodec.decode({ text })).toEqual([
      ['a', 'b & c'],
      ['two\nlines', '']
    ]);
  });
});
