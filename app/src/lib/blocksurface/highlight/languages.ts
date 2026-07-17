// The supported-language registry — pure data, NO Prism import, so both the
// worker's tokenizer and the main-thread painter (and, later, the language picker)
// can share it without dragging Prism onto the main thread. This is the single
// source of truth for "which fence languages highlight".

/** Fence info strings (and common aliases) mapped to a canonical Prism grammar
 *  name. Only these highlight; anything else degrades to plain monospace. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  js: 'javascript',
  javascript: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  py: 'python',
  python: 'python',
  rs: 'rust',
  rust: 'rust',
  go: 'go',
  golang: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  'c++': 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  csharp: 'csharp',
  dotnet: 'csharp',
  rb: 'ruby',
  ruby: 'ruby',
  php: 'php',
  kt: 'kotlin',
  kts: 'kotlin',
  kotlin: 'kotlin',
  swift: 'swift',
  scala: 'scala',
  dart: 'dart',
  objc: 'objectivec',
  objectivec: 'objectivec',
  lua: 'lua',
  r: 'r',
  ex: 'elixir',
  exs: 'elixir',
  elixir: 'elixir',
  hs: 'haskell',
  haskell: 'haskell',
  pl: 'perl',
  perl: 'perl',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  sh: 'bash',
  bash: 'bash',
  shell: 'bash',
  zsh: 'bash',
  ps1: 'powershell',
  pwsh: 'powershell',
  powershell: 'powershell',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  docker: 'docker',
  dockerfile: 'docker',
  diff: 'diff',
  patch: 'diff',
  zig: 'zig',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
  markup: 'markup',
  css: 'css',
  md: 'markdown',
  markdown: 'markdown'
};

/** Resolve a fence info string to a supported Prism grammar name, or null when the
 *  language is unknown. Case-insensitive; only the first whitespace-delimited token
 *  is the language (the rest of a fence info string is `meta`). */
export function resolveLanguage(lang: string): string | null {
  const key = lang.trim().toLowerCase().split(/\s+/)[0] ?? '';
  return LANGUAGE_ALIASES[key] ?? null;
}

/** True when a language will highlight — the painter reads this to decide whether
 *  to ask the worker for tokens at all. */
export function isSupportedLanguage(lang: string): boolean {
  return resolveLanguage(lang) !== null;
}

/** Human labels for each canonical grammar — what the corner picker shows and lists.
 *  Keyed by canonical name (the value `resolveLanguage` returns). */
const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  jsx: 'JSX',
  tsx: 'TSX',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  objectivec: 'Objective-C',
  ruby: 'Ruby',
  php: 'PHP',
  kotlin: 'Kotlin',
  swift: 'Swift',
  scala: 'Scala',
  dart: 'Dart',
  perl: 'Perl',
  lua: 'Lua',
  r: 'R',
  elixir: 'Elixir',
  haskell: 'Haskell',
  zig: 'Zig',
  json: 'JSON',
  yaml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  bash: 'Shell',
  powershell: 'PowerShell',
  sql: 'SQL',
  graphql: 'GraphQL',
  docker: 'Dockerfile',
  diff: 'Diff',
  markup: 'HTML',
  css: 'CSS',
  markdown: 'Markdown'
};

/** The label to show for a block's stored language: the pretty name when the
 *  language is recognised, the raw fence string when it is set but unknown (still
 *  the user's choice — shown verbatim, just uncoloured), or "Plain text" for none. */
export function languageLabel(lang: string): string {
  const name = resolveLanguage(lang);
  if (name) return LANGUAGE_LABELS[name] ?? name;
  return lang.trim() ? lang.trim() : 'Plain text';
}

/** A menu choice: `value` is stored on the block (canonical, or '' for plain), and
 *  `label` is shown. `''` is the "Plain text" row. */
export type LanguageChoice = { value: string; label: string };

/** The picker's choices: "Plain text" first, then every supported language sorted by
 *  label. Selecting one stores its canonical name, which drives both highlighting
 *  and the `.md` fence info string. */
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [
  { value: '', label: 'Plain text' },
  ...Object.entries(LANGUAGE_LABELS)
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label))
];
