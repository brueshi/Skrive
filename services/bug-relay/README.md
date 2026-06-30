# bug-relay

A stateless Cloudflare Worker that turns an in-app Skrive bug report into a
`Bug`-labeled issue in the Skrive Linear team. It exists so the Linear API key
never has to ship in the public client. See Linear **SKR-130** for the full plan.

## Why this is public

The Worker source lives in the public client repo on purpose. It holds **no**
secrets — the Linear API key and the Turnstile secret live only in Cloudflare's
secret store (`wrangler secret`). Publishing the code lets anyone verify the
relay forwards exactly what the report form shows and nothing more, which
reinforces Skrive's no-telemetry posture.

## Endpoint

`POST /report`

```json
{
  "subject": "string (1–200 chars, required)",
  "body": "string (1–8000 chars, required)",
  "diagnostics": { "appVersion": "1.8.1", "platform": "darwin", "host": "zig-native", "locale": "en-US" },
  "turnstileToken": "string (required once Turnstile is enabled)"
}
```

- `diagnostics` is optional and runs through a strict server-side allowlist
  (`appVersion`, `platform`, `host`, `locale`) — any other field is dropped.
- Success: `201 { "ok": true, "identifier": "SKR-XXX", "url": "..." }`
- Failure: `4xx/5xx { "ok": false, "error": "..." }`

## First-time setup

1. Authenticate the CLI (one-time, opens a browser):
   ```sh
   bunx wrangler login
   ```
2. Install the Linear API key as a production secret (created in Linear →
   Settings → API → Personal API keys):
   ```sh
   bunx wrangler secret put LINEAR_API_KEY
   ```
3. For local testing, copy `.dev.vars.example` to `.dev.vars` and paste the same
   key. `.dev.vars` is gitignored — never commit it.

## Develop & test locally

```sh
bun run dev        # wrangler dev, serves on http://localhost:8787
```

```sh
curl -s http://localhost:8787/report \
  -H 'Content-Type: application/json' \
  -d '{"subject":"Test report","body":"Hello from curl"}' | jq
```

A successful call creates a real `Bug` issue in Linear and returns its
identifier. (There is no test mode yet — it writes to the live team.)

## Deploy

```sh
bun run deploy     # wrangler deploy → https://skrive-bug-relay.<account>.workers.dev
```

## Operational levers

- **Kill switch:** set `INTAKE_ENABLED = "false"` in `wrangler.toml` and redeploy
  to reject all intake instantly (`503 intake_disabled`).
- **Rate limiting** (optional, off until a KV namespace is bound):
  ```sh
  bunx wrangler kv namespace create RATE_LIMIT
  ```
  then uncomment the `[[kv_namespaces]]` block in `wrangler.toml` with the
  printed id. Defaults to 5 reports per IP per hour.
- **Turnstile** (optional, off until the secret is set): create a Turnstile
  widget in the Cloudflare dashboard, then
  `bunx wrangler secret put TURNSTILE_SECRET`. Once present, the Worker requires
  a valid `turnstileToken` on every request.
