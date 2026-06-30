/**
 * Skrive bug-report relay.
 *
 * A stateless Cloudflare Worker that accepts a bug report from the Skrive
 * client and creates a `Bug`-labeled issue in the Skrive Linear team. The
 * Linear API key lives only in this Worker's secret store — never in the OSS
 * client, never in this repo. See ./README.md and Linear SKR-130.
 *
 * Privacy: this endpoint only ever creates an issue from a user-initiated,
 * fully-visible submission. Diagnostics are passed through a strict server-side
 * allowlist (sanitizeDiagnostics) so document content can never leak even if a
 * future client sends extra fields.
 */

export interface Env {
  // Public config (wrangler.toml [vars]) — safe to commit.
  LINEAR_TEAM_ID: string;
  LINEAR_BUG_LABEL_ID: string;
  LINEAR_FEEDBACK_LABEL_ID: string;
  LINEAR_ASSIGNEE_ID: string; // who reports are auto-assigned to
  INTAKE_ENABLED: string; // kill switch: "false" rejects all intake
  // Secrets (wrangler secret put ...) — NEVER committed.
  LINEAR_API_KEY: string;
  TURNSTILE_SECRET?: string; // when set, Turnstile verification is enforced
  // Optional KV binding for per-IP rate limiting (see wrangler.toml).
  RATE_LIMIT?: KVNamespace;
}

const SUBJECT_MAX = 200;
const BODY_MAX = 8000;
const DIAG_VALUE_MAX = 100;
const RATE_LIMIT_MAX = 5; // reports per IP per window
const RATE_LIMIT_WINDOW_S = 3600; // 1 hour

const LINEAR_GRAPHQL = "https://api.linear.app/graphql";
const TURNSTILE_VERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// The only diagnostics fields the relay will ever forward. Anything else a
// client sends is silently dropped — never document content, never paths.
const DIAG_FIELDS = ["appVersion", "platform", "host", "locale"] as const;

// Report type → Linear routing. Priority on Linear's scale: 2 = High, 3 = Medium.
// Both types auto-assign to LINEAR_ASSIGNEE_ID (solo team).
type ReportType = "bug" | "feedback";

function routingFor(type: ReportType, env: Env): { labelId: string; priority: number } {
  return type === "feedback"
    ? { labelId: env.LINEAR_FEEDBACK_LABEL_ID, priority: 3 }
    : { labelId: env.LINEAR_BUG_LABEL_ID, priority: 2 };
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

interface ReportPayload {
  subject?: unknown;
  body?: unknown;
  type?: unknown;
  diagnostics?: unknown;
  turnstileToken?: unknown;
}

interface CreatedIssue {
  identifier: string;
  url: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/report") {
      return json(404, { ok: false, error: "not_found" });
    }

    // Kill switch — flip INTAKE_ENABLED to "false" to stop accepting reports.
    if (env.INTAKE_ENABLED !== "true") {
      return json(503, { ok: false, error: "intake_disabled" });
    }

    let payload: ReportPayload;
    try {
      payload = (await request.json()) as ReportPayload;
    } catch {
      return json(400, { ok: false, error: "invalid_json" });
    }

    const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
    const body = typeof payload.body === "string" ? payload.body.trim() : "";
    if (!subject || subject.length > SUBJECT_MAX) {
      return json(400, { ok: false, error: "invalid_subject" });
    }
    if (!body || body.length > BODY_MAX) {
      return json(400, { ok: false, error: "invalid_body" });
    }

    // Turnstile is enforced only once the secret is configured, so stage-1
    // curl testing works before a widget exists.
    if (env.TURNSTILE_SECRET) {
      const token = typeof payload.turnstileToken === "string" ? payload.turnstileToken : "";
      const passed = await verifyTurnstile(token, env.TURNSTILE_SECRET, request);
      if (!passed) return json(403, { ok: false, error: "turnstile_failed" });
    }

    // Per-IP rate limit is enforced only when a KV namespace is bound.
    if (env.RATE_LIMIT) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (await isRateLimited(env.RATE_LIMIT, ip)) {
        return json(429, { ok: false, error: "rate_limited" });
      }
    }

    const type: ReportType = payload.type === "feedback" ? "feedback" : "bug";
    const description = composeDescription(body, payload.diagnostics);

    try {
      const issue = await createLinearIssue(env, subject, description, type);
      return json(201, { ok: true, identifier: issue.identifier, url: issue.url });
    } catch (err) {
      console.error("issueCreate failed", err);
      return json(502, { ok: false, error: "linear_create_failed" });
    }
  },
};

async function verifyTurnstile(token: string, secret: string, request: Request): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);
  const res = await fetch(TURNSTILE_VERIFY, { method: "POST", body: form });
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

/**
 * Fixed-window per-IP counter. KV is eventually consistent, so this is a soft
 * abuse mitigation, not a hard guarantee — adequate for a niche endpoint.
 */
async function isRateLimited(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `rl:${ip}`;
  const current = parseInt((await kv.get(key)) ?? "0", 10);
  if (current >= RATE_LIMIT_MAX) return true;
  await kv.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_S });
  return false;
}

function composeDescription(body: string, diagnostics: unknown): string {
  const diag = sanitizeDiagnostics(diagnostics);
  if (!diag) return body;
  const lines = Object.entries(diag).map(([k, v]) => `- ${k}: ${v}`);
  return `${body}\n\n---\n\n**Diagnostics**\n\n${lines.join("\n")}`;
}

function sanitizeDiagnostics(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "object") return null;
  const source = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const field of DIAG_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value.length <= DIAG_VALUE_MAX) {
      out[field] = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

async function createLinearIssue(
  env: Env,
  title: string,
  description: string,
  type: ReportType,
): Promise<CreatedIssue> {
  const { labelId, priority } = routingFor(type, env);
  const query = `
    mutation CreateReport($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { identifier url }
      }
    }`;
  const variables = {
    input: {
      teamId: env.LINEAR_TEAM_ID,
      title,
      description,
      labelIds: [labelId],
      priority,
      assigneeId: env.LINEAR_ASSIGNEE_ID,
    },
  };

  const res = await fetch(LINEAR_GRAPHQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Linear personal API keys are sent as the raw Authorization value.
      Authorization: env.LINEAR_API_KEY,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}`);

  const data = (await res.json()) as {
    data?: { issueCreate?: { success: boolean; issue?: CreatedIssue } };
    errors?: unknown;
  };
  const created = data.data?.issueCreate;
  if (!created?.success || !created.issue) {
    throw new Error(`Linear issueCreate failed: ${JSON.stringify(data.errors ?? data)}`);
  }
  return created.issue;
}
