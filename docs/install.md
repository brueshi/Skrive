# Installing Skrive

Skrive is pre-alpha. Expect rough edges. Grab the latest build from [Releases](https://github.com/brueshi/Skrive/releases).

## macOS

1. Download the `.dmg`.
2. Open it and drag **Skrive** to `Applications`.
3. Launch from Launchpad or Spotlight.

The macOS build is signed with a Developer ID certificate and notarized by Apple, so it opens without the "unidentified developer" warning. If you do see a Gatekeeper prompt, it's because macOS hasn't phoned home to verify the notarization ticket yet — wait a minute and try again, or right-click the app and choose **Open**.

## Windows

1. Download the `.msi`.
2. Double-click to run the installer.

Windows SmartScreen will warn: **"Microsoft Defender SmartScreen prevented an unrecognized app from starting."** Skrive isn't signed on Windows yet — that warning disappears once we pay for an EV code-signing certificate, which is deferred until a public launch.

To install anyway:

1. Click **More info**.
2. Click **Run anyway**.

## Linux

Not shipping Linux builds yet. Build from source via `npm run tauri build`.

## First launch

Skrive has no welcome screen. When you launch the app with nothing open, you'll see a **Create project** button — pick a folder of Markdown files (or an empty folder to start fresh). After that, double-clicking a `.md` file in Finder / Explorer opens it in Skrive with the surrounding project auto-detected.

## Updates

Skrive checks for updates on launch. When a new version is available, a toast appears in the corner with an **Install & restart** button. Click it and the app downloads the new build, verifies its signature, installs, and relaunches — no manual download needed.

You can also trigger a check any time via the project name dropdown → **Check for updates…**.

## Known rough edges

- No rename-with-references yet.
- No backlinks or link-graph UI yet.
- Export pipeline (Astro, PDF) not implemented.
