You are the Opus orchestrator for fix set 3 of 12-11-2026 in the Ranch repo (a Herdr layout + mods).

READ FIRST, fully, in this order:
1. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/README.md  (coordination: ownership map, overlap, merge order, rules for every tab)
2. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/3-session-git-caching-improvement.md  (your report: this is the work)
3. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/4-integrity-audit.md  (only the sections named below, plus "Review of the three supplied pending plans")

Your worktree (already created, branch fix/1211-caching, based on main bd639c6): ~/Projects/ranch-worktrees/3-caching
Work ONLY there. All code edits, tests and worker briefs use that path as the project root. The report files live in the main checkout above; read them from there.

GOAL: Stop the Session panel showing 'Refreshing…' on every tab switch: Option A (per-folder cache, shown first and updated in the background), then Option B (fewer git calls in lib/git.js). Option C only if the person wants it. Skip D and E. Also cover integrity-audit findings 9, 14, 15 and 18; you own lib/git.js and the Git/PR/watcher code in ranch-session.

SPECIFICS:
- Audit sections to read: findings 9, 14, 15, 18, and the review of herdr-ranch-session-git-caching.md. Do finding 9 (immutable {machine,cwd,repoTop,branch,generation} context per read/action, branch-aware PR readiness, guarded action-bar links and push) BEFORE or WITH the cache: 'a cache is not a fix if it can show another context's data'. Keep invariant I7.
- Correction from the audit: tests already exist (the report's 'no tests' claim is wrong). Add yours under test/.
- The timings in the report are from a Windows laptop. Measure cold/warm repoSummary on this Mac before and after, and report real numbers. Don't claim the ≤2.5 s target unless you measured it.
- Finding 18 (numstat -z parsing, remote-only default branch, exact host match, encoded compare refs) is in lib/git.js, which you own. Run `npm run sync` so the ranch-session / ranch-sidebar / ranch-files copies stay identical.
- Finding 14: fix the ranch-session watcher lifecycle and caches. The sidebar parts of 14 are yours too, but coordinate: tab 4 owns sidebar finding 16 (topOf negative caching), so keep your sidebar changes to watchers, cache pruning and the shared PR queue.

HOW TO WORK (mandatory):
- Follow the "Orchestrator protocol" in ~/.claude/CLAUDE.md exactly. Plan, delegate to Herdr sub-agent workers (hc run --bg, opencode, unique --session, ~10 s apart, project root = your worktree), and review every diff yourself before accepting it. Use the Ranch task list per ~/.claude/RANCH.md.
- Step 0: run `npm test` and `npm run check` in your worktree and record the baseline. Then check every claim and line number in the report against the actual code before planning. The reports were written on Windows against installed copies. Where the code disagrees with the report, trust the code and note the difference.
- Use systematic debugging and TDD: write a failing regression test for each bug before fixing it. The report's "Tests" / "Regression check" lists are the minimum.
- Edit the source lib/ (never only the mod copies); run `npm run sync` before tests.
- Never touch the live install or user config/data (~/.config/herdr-app/mods, ~/.herdr/ranch, ~/.claude, ~/.codex, ~/.config/opencode, shared agent instructions). Never run npm run reload, scripts/link-dev.sh, or ranch-tasks install/uninstall. Write live-data cleanups and instruction-file edits as proposals for the person.
- Stay inside your ownership (README table). If you need a change in a file or finding another tab owns, do not make it. Write it under "Cross-tab requests" in your final report.
- Decisions that are the person's (design choices, scope changes, anything that deletes or migrates data, security/permissions): ask with AskUserQuestion; don't guess.
- Do not commit or push unless the person asks in this tab.

DONE WHEN: every item you own is fixed with tests or explicitly deferred with a reason; `npm run verify` is no worse than the baseline (list any remaining failures, and say whether they existed before); and you have written /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/reports/3-caching-result.md. That file holds: what changed (file:line), tests added, verification output, deviations from the report, live-data/instruction proposals for the person, cross-tab requests, and open issues. Then summarise it in this tab.
