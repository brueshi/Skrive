// Client side of the in-app bug reporter (SKR-130). Owns the optional
// diagnostics payload and the submit call. The report is POSTed straight to the
// Cloudflare relay (services/bug-relay) — a public endpoint that holds the
// Linear key server-side, so the call carries no secret and renderer-side fetch
// is safe. (We chose renderer fetch over host-side IPC because the payload is
// non-sensitive and it's identical on macOS + Windows; see SKR-130.)
//
// Privacy: diagnostics carry version/OS/build only. Never note text, file
// paths, or project contents. The relay also re-filters server-side, so this
// allowlist is the client half of a two-sided guarantee.

export interface BugReportDiagnostics {
  appVersion: string;
  platform: string;
  host: 'zig-native' | 'electron';
  locale: string;
}

export interface BugReportInput {
  subject: string;
  body: string;
  diagnostics?: BugReportDiagnostics;
}

export interface BugReportResult {
  identifier: string;
  url: string;
}

/** Collect the low-risk diagnostics the report can optionally attach. */
export async function gatherDiagnostics(): Promise<BugReportDiagnostics> {
  const [appVersion, platform] = await Promise.all([
    window.skrive.app.version(),
    window.skrive.app.platform()
  ]);
  return {
    appVersion,
    platform,
    host: window.__SKRIVE_NATIVE_SHELL__ === true ? 'zig-native' : 'electron',
    locale: navigator.language
  };
}

// Public relay endpoint (services/bug-relay). Not a secret — the Linear key
// lives in the Worker, not here. Discoverable from network traffic regardless.
const BUG_RELAY_URL = 'https://skrive-bug-relay.bruechnerjoseph.workers.dev/report';

interface RelayResponse {
  ok?: boolean;
  identifier?: string;
  url?: string;
  error?: string;
}

/** POST the report to the relay, which creates the `Bug`-labeled Linear issue.
 *  Throws with a human-readable message on any failure so the caller can toast
 *  it — a report is never lost silently. */
export async function submitBugReport(input: BugReportInput): Promise<BugReportResult> {
  let res: Response;
  try {
    res = await fetch(BUG_RELAY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
  } catch {
    // Offline / DNS / connection refused — no response at all.
    throw new Error('Network error — check your connection and try again.');
  }

  let payload: RelayResponse | null = null;
  try {
    payload = (await res.json()) as RelayResponse;
  } catch {
    // Non-JSON body (e.g. an edge error page); fall through to the check below.
  }

  if (!res.ok || !payload?.ok || !payload.identifier) {
    const reason = payload?.error ?? `HTTP ${res.status}`;
    throw new Error(`The report couldn't be filed (${reason}).`);
  }

  return { identifier: payload.identifier, url: payload.url ?? '' };
}
