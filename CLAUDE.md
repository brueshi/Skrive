# CLAUDE.md — Skrive

Project context for Claude Code. The product overview lives in `planning/roadmap.html` and the Linear **Skrive Roadmap** initiative (team `SKR`; projects = waves, issues = features).

## Linear workflow — keep the board in sync

Treat Linear as the source of truth for what's in flight. Update it as work happens, using the Linear MCP:

- **Start work on an issue** → set it to **In Progress** and assign to Joe. Work on a branch named like Linear's generated form: `joe/skr-<n>-<slug>`.
- **Open a PR** → move the issue to **In Review**, and put `Fixes SKR-<n>` in the PR body so the GitHub integration links and auto-closes it on merge.
- **Verified / merged** → set the issue to **Done**.
- **A new piece of work that isn't a tracked issue** → create the issue first (correct wave project; labels for track `bedrock`/`differentiator`/`joy`/`cloud` and tier `free`/`supporter`/`paid`), then start.
- **End of a work session, or when a cycle or release milestone advances** → post a short status update (onTrack / atRisk / offTrack) on the active wave project.
- **Releases** are modeled as project **milestones** (e.g. `v1.8 — …`). Assign each issue to the milestone it ships in.

Dates on the roadmap are aggressive and AI-paced; if a cycle's velocity says a window is wrong, adjust the issue/project dates rather than letting them rot.
