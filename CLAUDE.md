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

## Editor toolbar — fixed by the affordance grammar

The editor toolbar has a **permanent set that a feature may never grow**: `[ Turn into ▾ ] | B  I  U  S | [ Insert ▾ ]` (bold / italic / underline / strikethrough; inline code and Link are bubble-only). A new feature may add a slash entry, an Insert-catalog row, a palette command, a keyboard shortcut, per-block chrome, or a settings control — but it may **never add a toolbar button**. Changing the permanent set requires editing the grammar doc first; that friction is deliberate — it is how the marks became `B I U S` (grammar resolved call 4, an owner amendment, not a feature).

Every affordance has one of five homes: the **selection bubble** (formatting on selected text), the **Insert catalog** (insertion — one `INSERT_CATALOG` registry rendered by the slash menu, the Insert dropdown, and the palette Insert group), **per-block chrome** (block-contextual actions, SKR-124), the **palette + View menu** (global commands, modes, toggles), and **ambient chrome** (glanceable non-commands). The full rules and the affordance inventory live in `planning/chrome-affordance-grammar.md` (LOCKED), with the navigation model in `planning/chrome-navigation-model.md`. Cite the grammar doc when placing a new feature's affordances.
