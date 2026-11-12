# Fixes for 12-11-2026: coordination

Five reports were transcribed from phone photos of Markdown files written on a Windows machine (against the
installed copies and the source clone at HEAD `bd639c6`, the same commit as this repo's `main`).
Each report is handled by its own Opus orchestrator in its own Herdr tab and its own git worktree.

| # | Report | Tab | Worktree / branch |
|---|---|---|---|
| 1 | `1-bugs-and-fixes.md` | `fix 1: bugs` | `~/Projects/ranch-worktrees/1-bugs` / `fix/1211-bugs` |
| 2 | `2-codex-task-reporting-fix.md` | `fix 2: codex tasks` | `~/Projects/ranch-worktrees/2-codex` / `fix/1211-codex` |
| 3 | `3-session-git-caching-improvement.md` | `fix 3: git caching` | `~/Projects/ranch-worktrees/3-caching` / `fix/1211-caching` |
| 4 | `4-integrity-audit.md` | `fix 4: integrity` | `~/Projects/ranch-worktrees/4-integrity` / `fix/1211-integrity` |
| 5 | `5-shepherdr-task-comparison.md` | `fix 5: task design` | `~/Projects/ranch-worktrees/5-design` / `fix/1211-design` |

## Overlap and ownership (read this before editing anything)

The integrity audit (report 4) re-states the other reports as findings. To stop two tabs fixing the same
thing in different ways, each audit finding has exactly one owner:

| Owner tab | Owns | Audit findings it also owns |
|---|---|---|
| 1 bugs | Bug 1 (cross-repo PR registry), Bug 2 (tab rename instruction), Bug 3 (`missed_turns`) | **8**, **13** (and the audit's "Add" and "Caution" notes on report 1) |
| 2 codex | Codex task reporting plan | **7** (and the Codex-specific part of 20: doctor's Codex check, `codexTrustState`) |
| 3 caching | Session Git caching plan (Options A, B; C optional) | **9**, **14**, **15**, **18** (owns `lib/git.js` and `ranch-session` Git/PR/watcher code) |
| 4 integrity | Everything else in the audit | **1-6**, **11**, **12**, **16**, **17**, **19**, **20** (except the Codex-specific part) |
| 5 design | Shepherdr comparison: single-setup design and native activity baseline | **10** (one effective status rule for Session/Sidebar/Topbar/close confirmation) |

Files touched by more than one tab (merge in the order below, rebase the later ones):
`adapters/{cli,claude,codex,store,install,instructions,doctor,opencode-plugin}.js`, `lib/{prs,tasks,git}.js`,
`mods/ranch-session/main.js`, `mods/ranch-sidebar/main.js`. `lib/` is copied into mods by `npm run sync`:
edit the source `lib/`, never only the copies.

## Dependencies and suggested merge order

1. **4 integrity, data-safety part (findings 2-6)** first. Report 5 says not to bundle the task runtime until these are fixed. Report 2 must not ship before shared-session locking and resume preservation are in.
2. **1 bugs**: small and independent. Bug 3 fix 1 (reset `missed_turns`) overlaps audit 13, owned here.
3. **3 caching**: owns `ranch-session` Git/PR context. Audit 9 (context ownership) must land with or before the cache.
4. **2 codex**: waits for the person's decision in report 5 §4 (A: bundle reporting, or B: native data only). The audit says not to build a custom `plan` command only to remove it in the next design. Report 5 recommends A, which keeps the command.
5. **5 design**: after 1-4. It needs the person's A/B decision first.

## Rules for every tab

- Work only in your own worktree. Never edit `~/Projects/ranch` (main) or another tab's worktree.
- Do not run `npm run reload` / `scripts/link-dev.sh`, `ranch-tasks install|uninstall`, or anything that touches the live Herdr install (`~/.config/herdr-app/mods`, `~/.herdr/ranch`, `~/.claude`, `~/.codex`, `~/.config/opencode`). Live data cleanup (for example moving the bad `prs.json` entry) and live instruction edits (for example the tab-rename section of the shared agent instructions) are proposals for the person to approve, never automatic.
- The reports were written on Windows. Paths like `C:\Raptor\...`, `%TEMP%\opencode\herdr-ranch` and `C:\Users\LH719EC\...` describe that machine. On this Mac the source is this repo. Line numbers refer to `bd639c6` and should match, but re-check them in the code.
- Verify with `npm test` and `npm run check` (or `npm run verify`). The audit reports 9 failing tests on Windows. Record the macOS baseline before changing anything.
- Do not commit, push or open PRs unless the person asks in that tab.
