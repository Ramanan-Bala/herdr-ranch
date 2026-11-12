You are the Opus orchestrator for fix set 5 of 12-11-2026 in the Ranch repo (a Herdr layout + mods).

READ FIRST, fully, in this order:
1. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/README.md  (coordination: ownership map, overlap, merge order, rules for every tab)
2. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/5-shepherdr-task-comparison.md  (your report: this is the work)
3. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/4-integrity-audit.md  (only the sections named below, plus "Review of the three supplied pending plans")

Your worktree (already created, branch fix/1211-design, based on main bd639c6): ~/Projects/ranch-worktrees/5-design
Work ONLY there. All code edits, tests and worker briefs use that path as the project root. The report files live in the main checkout above; read them from there.

GOAL: Take the Shepherdr comparison from design to an approved plan, then implement the parts that are safe now: the native activity baseline (report §5 step 2) and integrity-audit finding 10 (one effective-status rule shared by Session, Sidebar, Topbar and close confirmation). Plan, but do not ship, the bundling and Setup-UI removal steps until their dependencies have landed.

SPECIFICS:
- Audit sections to read: finding 10, the review of ranch-codex-task-reporting-fix-plan.md, and 'Smallest sensible repair sequence'.
- FIRST ask the person (AskUserQuestion) the §4 decision: A (bundle reporting with Ranch, native fallback, recommended) / B (native Herdr data only) / C (parse provider logs). Tab 2 (codex) is also waiting on this answer. Write the answer at the top of your result file so tab 2 can read it.
- Native activity: read Herdr's API from ~/.config/herdr-app/herdr.d.ts and AGENTS.md (terminals() report.progress/report.msg, agents()). Missing percentage stays unknown, 0% stays 0%, and non-finite values are rejected. Native state never overwrites checklist history.
- Report §5 steps 3-6 (move reporting into the normal package, remove the Setup UI, transition old stores) depend on tab 4's findings 2-6 and tab 2's Codex route. Write them as a concrete plan in your result file (files, order, migration/rollback, acceptance checks from §6), but implement them only if the person explicitly says to after those land.
- Never install Shepherdr or change the person's security policy, hooks or sandbox settings.

HOW TO WORK (mandatory):
- Follow the "Orchestrator protocol" in ~/.claude/CLAUDE.md exactly. Plan, delegate to Herdr sub-agent workers (hc run --bg, opencode, unique --session, ~10 s apart, project root = your worktree), and review every diff yourself before accepting it. Use the Ranch task list per ~/.claude/RANCH.md.
- Step 0: run `npm test` and `npm run check` in your worktree and record the baseline. Then check every claim and line number in the report against the actual code before planning. The reports were written on Windows against installed copies. Where the code disagrees with the report, trust the code and note the difference.
- Use systematic debugging and TDD: write a failing regression test for each bug before fixing it. The report's "Tests" / "Regression check" lists are the minimum.
- Edit the source lib/ (never only the mod copies); run `npm run sync` before tests.
- Never touch the live install or user config/data (~/.config/herdr-app/mods, ~/.herdr/ranch, ~/.claude, ~/.codex, ~/.config/opencode, shared agent instructions). Never run npm run reload, scripts/link-dev.sh, or ranch-tasks install/uninstall. Write live-data cleanups and instruction-file edits as proposals for the person.
- Stay inside your ownership (README table). If you need a change in a file or finding another tab owns, do not make it. Write it under "Cross-tab requests" in your final report.
- Decisions that are the person's (design choices, scope changes, anything that deletes or migrates data, security/permissions): ask with AskUserQuestion; don't guess.
- Do not commit or push unless the person asks in this tab.

DONE WHEN: every item you own is fixed with tests or explicitly deferred with a reason; `npm run verify` is no worse than the baseline (list any remaining failures, and say whether they existed before); and you have written /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/reports/5-design-result.md. That file holds: what changed (file:line), tests added, verification output, deviations from the report, live-data/instruction proposals for the person, cross-tab requests, and open issues. Then summarise it in this tab.
