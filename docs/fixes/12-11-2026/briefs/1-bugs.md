You are the Opus orchestrator for fix set 1 of 12-11-2026 in the Ranch repo (a Herdr layout + mods).

READ FIRST, fully, in this order:
1. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/README.md  (coordination: ownership map, overlap, merge order, rules for every tab)
2. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/1-bugs-and-fixes.md  (your report: this is the work)
3. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/4-integrity-audit.md  (only the sections named below, plus "Review of the three supplied pending plans")

Your worktree (already created, branch fix/1211-bugs, based on main bd639c6): ~/Projects/ranch-worktrees/1-bugs
Work ONLY there. All code edits, tests and worker briefs use that path as the project root. The report files live in the main checkout above; read them from there.

GOAL: Fix Bug 1 (cross-repo PR filed under the wrong checkout's registry), Bug 2 (tab rename hits the focused tab) and Bug 3 (sticky 'no task updates' badge), as the report proposes. Also cover integrity-audit findings 8 and 13, which restate these bugs with extra cases.

SPECIFICS:
- Audit sections to read: findings 8 and 13, and the review of herdr-ranch-bugs-and-fixes.md. Fold in its Add list (global `gh -R`, `tool_input.cmd`, URL-based row ids / dedup for the same PR number in two repos, duplicate Stop consumption, complete session reset) and its Caution: do NOT use the blanket 'only count when no in_progress item' rule. Define turn semantics with tests instead.
- Bug 1: keep the creator session's own-store record. Filter foreign repos only on registry reads. The prs.json cleanup is a proposal for the person, not something to apply.
- Bug 2: the fix is in a live shared instructions file outside this repo (on this Mac, find where the tab-rename instruction actually lives, e.g. RANCH.md/AGENTS.md text that Ranch's installer writes in adapters/instructions.js, and fix the repo-owned text). On macOS/zsh the snippet must be POSIX shell, not PowerShell. Fix only repo-owned text; propose edits to user-owned files.
- Bug 3 touches claude.js / codex.js / opencode-plugin.js, which tab 4 (integrity: session reset, locks) also edits. Keep your diff minimal and local to missed_turns/turn logic.

HOW TO WORK (mandatory):
- Follow the "Orchestrator protocol" in ~/.claude/CLAUDE.md exactly. Plan, delegate to Herdr sub-agent workers (hc run --bg, opencode, unique --session, ~10 s apart, project root = your worktree), and review every diff yourself before accepting it. Use the Ranch task list per ~/.claude/RANCH.md.
- Step 0: run `npm test` and `npm run check` in your worktree and record the baseline. Then check every claim and line number in the report against the actual code before planning. The reports were written on Windows against installed copies. Where the code disagrees with the report, trust the code and note the difference.
- Use systematic debugging and TDD: write a failing regression test for each bug before fixing it. The report's "Tests" / "Regression check" lists are the minimum.
- Edit the source lib/ (never only the mod copies); run `npm run sync` before tests.
- Never touch the live install or user config/data (~/.config/herdr-app/mods, ~/.herdr/ranch, ~/.claude, ~/.codex, ~/.config/opencode, shared agent instructions). Never run npm run reload, scripts/link-dev.sh, or ranch-tasks install/uninstall. Write live-data cleanups and instruction-file edits as proposals for the person.
- Stay inside your ownership (README table). If you need a change in a file or finding another tab owns, do not make it. Write it under "Cross-tab requests" in your final report.
- Decisions that are the person's (design choices, scope changes, anything that deletes or migrates data, security/permissions): ask with AskUserQuestion; don't guess.
- Do not commit or push unless the person asks in this tab.

DONE WHEN: every item you own is fixed with tests or explicitly deferred with a reason; `npm run verify` is no worse than the baseline (list any remaining failures, and say whether they existed before); and you have written /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/reports/1-bugs-result.md. That file holds: what changed (file:line), tests added, verification output, deviations from the report, live-data/instruction proposals for the person, cross-tab requests, and open issues. Then summarise it in this tab.
