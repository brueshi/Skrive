> **STALE (2026-06-22).** This is the Tauri-era release flow (`tauri-updater` signing, `src-tauri/Cargo.toml` + `tauri.conf.json` bumps, `tauri signer`). Current builds are Electron via `bun run package:*`. The Apple signing/notarization *secrets* setup still applies; the Tauri-updater and `src-tauri`/`tauri.conf.json` mechanics do not.

# Release process

Skrive ships via `.github/workflows/release.yml`. Push a `v*` tag, the workflow builds + signs + notarizes macOS, builds Windows (unsigned), and creates a draft GitHub Release with both bundles attached. You then review the release page and publish.

---

## One-time setup: GitHub Secrets

Before the first release works, eight repo secrets need to exist. Go to **Settings → Secrets and variables → Actions → New repository secret** and add each one. Six are for macOS signing + notarization, two are for the Tauri auto-updater's bundle signing. `GITHUB_TOKEN` is provided automatically by Actions.

### `APPLE_CERTIFICATE` — your Developer ID Application cert as base64

1. In Xcode, go to **Settings → Accounts**, pick your Apple ID, click **Manage Certificates**, and make sure you have a **Developer ID Application** certificate. If not, click the `+` and add one.
2. Open **Keychain Access** → **My Certificates** and find `Developer ID Application: <Your Name> (<TEAM_ID>)`.
3. Right-click → **Export**, choose **.p12**, set a strong password, save somewhere temporary.
4. Convert to base64:

   ```bash
   base64 -i DeveloperID.p12 | pbcopy
   ```

5. Paste the clipboard contents as the secret value. Delete the `.p12` file once the secret is stored.

### `APPLE_CERTIFICATE_PASSWORD`

The password you set when exporting the `.p12`.

### `APPLE_SIGNING_IDENTITY`

The exact name of the certificate as codesign sees it. Get it with:

```bash
security find-identity -v -p codesigning
```

It looks like: `Developer ID Application: Your Name (AB12CD34EF)`. Paste that full string.

### `APPLE_ID`

The email address of the Apple ID that owns the Developer Program membership.

### `APPLE_PASSWORD` — app-specific, not your regular Apple ID password

1. Sign in at [appleid.apple.com](https://appleid.apple.com).
2. Under **Sign-In and Security → App-Specific Passwords**, generate one (label it "Skrive notarization" or similar).
3. Paste the generated password (format: `xxxx-xxxx-xxxx-xxxx`) as the secret.

### `APPLE_TEAM_ID`

Your 10-character Team ID. Find it at [developer.apple.com/account](https://developer.apple.com/account) → **Membership**. Same value that's in parentheses in the signing identity above.

### Tauri updater keypair: `TAURI_SIGNING_PRIVATE_KEY` + `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The Tauri updater is its own verification layer *on top of* OS code signing. Each update bundle is signed with a Tauri-specific key, and the app rejects any bundle whose signature doesn't match the embedded public key. This stops an attacker who could somehow intercept your update endpoint from pushing a malicious bundle — it'd fail the client-side check even if it had a valid Apple Developer signature.

Generating the keypair is a one-time local step:

```bash
npm run tauri signer generate -- --write-keys ~/.tauri/skrive.key
```

The command prompts for a password (used to encrypt the private key file) and writes:

- `~/.tauri/skrive.key` — the encrypted private key. Keep this secret.
- `~/.tauri/skrive.key.pub` — the public key. This is what gets embedded in the app.

Then:

1. Copy the contents of `skrive.key.pub` into `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. The `.pub` file is *already* a single line of base64 — paste it as-is. Do **not** run `base64` on it again; double-encoding produces a value the updater rejects with `Missing encoded key in public key`. Commit.
2. Copy the contents of the private key file as the secret value:

   ```bash
   cat ~/.tauri/skrive.key | pbcopy
   ```

   Paste as `TAURI_SIGNING_PRIVATE_KEY`. The Tauri CLI parses this as the minisign-format text directly (two lines: an `untrusted comment:` header and the base64 payload). Don't `base64` the file — that produces `Missing encoded key in secret key` at build time.
3. Paste the password you chose as `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

**Back up the key file.** If you lose it, all installed clients are stranded on their current version — there's no way to re-sign with a different key without re-shipping a build with a new public key embedded, which requires a manual reinstall. A copy in a password manager or encrypted backup is sufficient.

---

## Cutting a release

1. **Bump the version** in three files:
   - `package.json` → `"version"`
   - `src-tauri/Cargo.toml` → `[package] version`
   - `src-tauri/tauri.conf.json` → `"version"`

   Keep them in sync. Use semver: `0.0.1` → `0.1.0` for a meaningful change, `0.0.1` → `0.0.2` for a patch.

2. **Refresh `Cargo.lock`** so the bumped version lands there too:

   ```bash
   cargo check
   ```

3. **Commit**:

   ```bash
   git commit -am "chore: bump to v0.1.0"
   ```

4. **Tag and push**:

   ```bash
   git tag v0.1.0
   git push origin main --tags
   ```

5. **Watch the action** at **Actions → Release** in the GitHub UI. Two jobs run in parallel: `build (macos-latest)` (~15-20 min including notarization) and `build (windows-latest)` (~10 min).

6. **Publish the draft release.** Once both jobs are green, a new draft release appears under **Releases**. Edit the notes if you want, then click **Publish release**.

## Testing the build without cutting a release

Use the **workflow_dispatch** button in the Actions UI to run the workflow without tagging. No release is created; the bundles appear as artifacts on the run page for download.

## If notarization fails

The macOS job will fail at the notarize step if Apple rejects the submission. Usually it's a certificate expiry, a bad app-specific password, or an entitlements issue. Grab the submission UUID from the log and run:

```bash
xcrun notarytool log <submission-id> --apple-id $APPLE_ID --team-id $APPLE_TEAM_ID --password $APPLE_PASSWORD
```

locally to see the detailed error. Most commonly: regenerate the app-specific password, update the secret.

## Runner minutes (cost note)

For public repos, macOS runners are free. If Skrive's repo ever goes private, macOS minutes burn 10× the rate of Linux — a single release eats ~200 billed minutes. Budget accordingly.
