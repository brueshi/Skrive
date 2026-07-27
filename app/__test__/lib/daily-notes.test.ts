// Resolving where today's note lives, and what it opens with.

import { describe, expect, it } from 'vitest';
import {
  dailyNotePath,
  renderDailyTemplate
} from '../../src/lib/daily-notes';
import { DEFAULT_APP_UI_STATE } from '@skrive/shared';

const DAY = new Date(2026, 2, 8);

describe('dailyNotePath', () => {
  it('joins the folder and appends .md', () => {
    expect(dailyNotePath(DAY, 'Daily', 'YYYY-MM-DD', 'md')).toBe(
      'Daily/2026-03-08.md'
    );
  });

  it('files at the project root when the folder is empty', () => {
    expect(dailyNotePath(DAY, '', 'YYYY-MM-DD', 'md')).toBe('2026-03-08.md');
    expect(dailyNotePath(DAY, '   ', 'YYYY-MM-DD', 'md')).toBe('2026-03-08.md');
  });

  it('nests when the pattern contains slashes', () => {
    expect(dailyNotePath(DAY, 'Journal', 'YYYY/MM/DD', 'md')).toBe(
      'Journal/2026/03/08.md'
    );
  });

  it('does not double the extension', () => {
    expect(dailyNotePath(DAY, 'Daily', '[note].md', 'md')).toBe('Daily/note.md');
    // Case-insensitively, so a pattern ending .MD is not given a second
    // extension on a filesystem that considers the two the same file. The
    // whole literal needs bracketing here: unescaped, ".MD" is month-day.
    expect(dailyNotePath(DAY, 'Daily', '[note.MD]', 'md')).toBe('Daily/note.MD');
  });

  it('honours bracketed literals in the pattern', () => {
    expect(dailyNotePath(DAY, 'Daily', '[Daily]-YYYY-MM-DD', 'md')).toBe(
      'Daily/Daily-2026-03-08.md'
    );
  });

  it('cannot be walked out of the project', () => {
    expect(dailyNotePath(DAY, '../../secrets', 'YYYY', 'md')).toBe(
      'secrets/2026.md'
    );
    expect(dailyNotePath(DAY, 'Daily', '[../..]/YYYY', 'md')).toBe(
      'Daily/2026.md'
    );
  });

  it('returns null when the pattern yields no usable name', () => {
    expect(dailyNotePath(DAY, 'Daily', '', 'md')).toBeNull();
    expect(dailyNotePath(DAY, 'Daily', '   ', 'md')).toBeNull();
    expect(dailyNotePath(DAY, 'Daily', '???', 'md')).toBeNull();
  });

  it('takes the extension from the format, not the pattern', () => {
    expect(dailyNotePath(DAY, 'Daily', 'YYYY-MM-DD', 'folio')).toBe(
      'Daily/2026-03-08.folio'
    );
    // A pattern naming one extension does not override the chosen format;
    // it just becomes part of the filename.
    expect(dailyNotePath(DAY, 'Daily', '[note].md', 'folio')).toBe(
      'Daily/note.md.folio'
    );
    expect(dailyNotePath(DAY, 'Daily', '[note].folio', 'folio')).toBe(
      'Daily/note.folio'
    );
  });

  it('resolves the shipped default to a sensible path', () => {
    expect(
      dailyNotePath(
        DAY,
        DEFAULT_APP_UI_STATE.dailyNotesFolder,
        DEFAULT_APP_UI_STATE.dailyNotesDateFormat,
        DEFAULT_APP_UI_STATE.dailyNotesFormat
      )
    ).toBe('Daily/2026-03-08.md');
  });
});

describe('renderDailyTemplate', () => {
  it('expands the date token through the configured pattern', () => {
    expect(renderDailyTemplate('# {{date}}\n\n', DAY, 'YYYY-MM-DD')).toBe(
      '# 2026-03-08\n\n'
    );
    expect(renderDailyTemplate('# {{date}}', DAY, 'dddd, D MMMM')).toBe(
      '# Sunday, 8 March'
    );
  });

  it('expands every occurrence', () => {
    expect(renderDailyTemplate('{{date}} / {{date}}', DAY, 'YYYY')).toBe(
      '2026 / 2026'
    );
  });

  it('leaves a template without the token alone', () => {
    expect(renderDailyTemplate('## Notes\n', DAY, 'YYYY')).toBe('## Notes\n');
    expect(renderDailyTemplate('', DAY, 'YYYY')).toBe('');
  });

  it('renders the shipped default template', () => {
    expect(
      renderDailyTemplate(
        DEFAULT_APP_UI_STATE.dailyNotesTemplate,
        DAY,
        DEFAULT_APP_UI_STATE.dailyNotesDateFormat
      )
    ).toBe('# 2026-03-08\n\n');
  });
});
