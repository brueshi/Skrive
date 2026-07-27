// Token-based date formatting for user-authored patterns.
//
// Daily notes name their file from a pattern the writer controls, so this
// has to survive whatever they type. Two consequences shape the design:
//
// Literal text needs escaping. A pattern like "Daily-YYYY" would otherwise
// have its "D" read as the day-of-month and render "26aily-2026". Square
// brackets pass their contents through untouched: "[Daily]-YYYY".
//
// Month and weekday names are fixed English, not locale-derived. These
// patterns name files on disk, and a filename that changes when the OS
// language changes would strand yesterday's notes under names today's app
// no longer generates. A writer wanting localised names can put them in the
// template, which is prose, rather than in the filename pattern.

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December'
] as const;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday'
] as const;

// Longest-first within each letter group, so YYYY is not consumed as two YYs.
// The bracket alternative leads, so an escaped run is claimed before any
// token inside it can match.
const TOKEN = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|dddd|ddd|DD|D|HH|mm|ss/g;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Render `date` through a token pattern. Unrecognised characters pass
 *  through as literals; `[...]` escapes a run that would otherwise tokenise. */
export function formatDate(date: Date, pattern: string): string {
  return pattern.replace(TOKEN, (match, escaped?: string) => {
    if (escaped !== undefined) return escaped;
    switch (match) {
      case 'YYYY':
        return String(date.getFullYear()).padStart(4, '0');
      case 'YY':
        return pad(date.getFullYear() % 100);
      case 'MMMM':
        return MONTHS[date.getMonth()] ?? '';
      case 'MMM':
        return (MONTHS[date.getMonth()] ?? '').slice(0, 3);
      case 'MM':
        return pad(date.getMonth() + 1);
      case 'M':
        return String(date.getMonth() + 1);
      case 'dddd':
        return WEEKDAYS[date.getDay()] ?? '';
      case 'ddd':
        return (WEEKDAYS[date.getDay()] ?? '').slice(0, 3);
      case 'DD':
        return pad(date.getDate());
      case 'D':
        return String(date.getDate());
      case 'HH':
        return pad(date.getHours());
      case 'mm':
        return pad(date.getMinutes());
      case 'ss':
        return pad(date.getSeconds());
      default:
        return match;
    }
  });
}

// Characters no path segment may carry. The Windows set is the strict one,
// and applying it everywhere keeps a project portable between machines
// rather than producing notes that only open where they were written.
// Hyphens and spaces are deliberately absent - both are ordinary in a
// date pattern, and stripping them would quietly turn YYYY-MM-DD into
// YYYYMMDD. The control-character range is written as escapes, not raw
// bytes, so the class stays visible in a diff.
// eslint-disable-next-line no-control-regex -- control chars are the point
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*\x00-\x1f]/g;

/** Normalise a user-derived project-relative path: forward slashes, no
 *  empty or dot segments, no characters that would be illegal on Windows.
 *
 *  Traversal segments are dropped rather than rejected. The pattern comes
 *  from a settings field, so a stray `..` is far more likely to be a typo
 *  than an attempt to escape the project — but it must not be honoured
 *  either, so it is simply removed. Returns '' if nothing usable survives. */
export function sanitizeRelPath(raw: string): string {
  return raw
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => seg.replace(ILLEGAL_SEGMENT_CHARS, '').trim())
    // A segment of dots is either a no-op ('.') or traversal ('..'); both go.
    .filter((seg) => seg.length > 0 && !/^\.+$/.test(seg))
    .join('/');
}
