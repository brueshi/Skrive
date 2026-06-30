// Client side of the in-app bug reporter (SKR-130). Owns the optional
// diagnostics payload and the submit call. The transport is mocked at this
// stage: stage 3 replaces only `submitBugReport`'s body with the host-side
// `window.skrive.bugReport.submit` IPC egress — the signature and every call
// site stay the same.
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

/** Submit a bug report.
 *
 *  Stage-2 mock: resolves without touching the network so the form is fully
 *  exercisable (success path, busy state, toasts). Stage 3 (SKR-130) swaps this
 *  body for `window.skrive.bugReport.submit(input)`, which performs the real
 *  host-side POST to the Cloudflare relay. */
export async function submitBugReport(input: BugReportInput): Promise<BugReportResult> {
  console.info('[bug-report] stage-2 mock submit — not actually sent', input);
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { identifier: 'SKR-DEV', url: '' };
}
