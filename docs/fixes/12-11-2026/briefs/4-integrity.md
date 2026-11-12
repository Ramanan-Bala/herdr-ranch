You are the Opus orchestrator for fix set 4 of 12-11-2026 in the Ranch repo (a Herdr layout + mods).

READ FIRST, fully, in this order:
1. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/README.md  (coordination: ownership map, overlap, merge order, rules for every tab)
2. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/4-integrity-audit.md  (your report: this is the work)
3. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/4-integrity-audit.md  (only the sections named below, plus "Review of the three supplied pending plans")

Your worktree (already created, branch fix/1211-integrity, based on main bd639c6): ~/Projects/ranch-worktrees/4-integrity
Work ONLY there. All code edits, tests and worker briefs use that path as the project root. The report files live in the main checkout above; read them from there.

GOAL: Fix the integrity-audit findings this tab owns: 1-6, 11, 12, 16, 17, 19 and 20 (except its Codex-specific parts). Follow the audit's 'Smallest sensible repair sequence': protect data first (2-6), then workspace ownership (1, 11), then settings/verification (12, 19, 20), then 16-17.

SPECIFICS:
- Findings owned by OTHER tabs (do not fix them; README has the map): 7 -> tab 2, 8 and 13 -> tab 1, 9, 14, 15 and 18 -> tab 3, 10 -> tab 5.
- Data-safety findings 2-6 are the top priority: tabs 2 and 5 are blocked on them. Test them only against isolated temp dirs (RANCH_HOME or a mocked fs), never the live ~/.herdr/ranch. Never run GC, uninstall or migration on live data.
- Finding 6 (installer cleanup): back up, hash and own only the exact bytes Ranch wrote. Strip individual hooks, not mixed groups. This must not touch the live ~/.claude, ~/.codex or ~/.config/opencode while testing.
- Finding 20: the audit's 9 failing tests were on Windows (ESM drive-letter imports, host-home contamination, POSIX path simulation). Record the macOS baseline first. Fix the test-isolation bugs (pathToFileURL, RANCH_HOME/homedir isolation) so they also pass on Windows by construction. Do not weaken or skip assertions.
- Finding 3 (lock the session file, not the terminal pointer) and finding 4 (complete session reset) touch claude.js, codex.js, opencode-plugin.js and store.js. Tab 1 edits the same files for missed_turns only. Keep your changes structural (locking, reset, load-on-resume) and leave missed_turns logic to tab 1.
- 'Additional safety/design notes' (Changes commits the whole repo with git add -A, etc.) are product decisions: list them for the person, don't change them.

HOW TO WORK (mandatory):
- Follow the "Orchestrator protocol" in ~/.claude/CLAUDE.md exactly. Plan, delegate to Herdr sub-agent workers (hc run --bg, opencode, unique --session, ~10 s apart, project root = your worktree), and review every diff yourself before accepting it. Use the Ranch task list per ~/.claude/RANCH.md.
- Step 0: run `npm test` and `npm run check` in your worktree and record the baseline. Then check every claim and line number in the report against the actual code before planning. The reports were written on Windows against installed copies. Where the code disagrees with the report, trust the code and note the difference.
- Use systematic debugging and TDD: write a failing regression test for each bug before fixing it. The report's "Tests" / "Regression check" lists are the minimum.
- Edit the source lib/ (never only the mod copies); run `npm run sync` before tests.
- Never touch the live install or user config/data (~/.config/herdr-app/mods, ~/.herdr/ranch, ~/.claude, ~/.codex, ~/.config/opencode, shared agent instructions). Never run npm run reload, scripts/link-dev.sh, or ranch-tasks install/uninstall. Write live-data cleanups and instruction-file edits as proposals for the person.
- Stay inside your ownership (README table). If you need a change in a file or finding another tab owns, do not make it. Write it under "Cross-tab requests" in your final report.
- Decisions that are the person's (design choices, scope changes, anything that deletes or migrates data, security/permissions): ask with AskUserQuestion; don't guess.
- Do not commit or push unless the person asks in this tab.

DONE WHEN: every item you own is fixed with tests or explicitly deferred with a reason; `npm run verify` is no worse than the baseline (list any remaining failures, and say whether they existed before); and you have written /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/reports/4-integrity-result.md. That file holds: what changed (file:line), tests added, verification output, deviations from the report, live-data/instruction proposals for the person, cross-tab requests, and open issues. Then summarise it in this tab.
