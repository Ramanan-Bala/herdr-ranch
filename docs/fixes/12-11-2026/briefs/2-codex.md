You are the Opus orchestrator for fix set 2 of 12-11-2026 in the Ranch repo (a Herdr layout + mods).

READ FIRST, fully, in this order:
1. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/README.md  (coordination: ownership map, overlap, merge order, rules for every tab)
2. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/2-codex-task-reporting-fix.md  (your report: this is the work)
3. /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/4-integrity-audit.md  (only the sections named below, plus "Review of the three supplied pending plans")

Your worktree (already created, branch fix/1211-codex, based on main bd639c6): ~/Projects/ranch-worktrees/2-codex
Work ONLY there. All code edits, tests and worker briefs use that path as the project root. The report files live in the main checkout above; read them from there.

GOAL: Make Codex sessions report tasks to the Ranch panel again (Codex 0.167+ dropped update_plan), as the report's Option A proposes. Also fix the secondary issues (exec_command / tool_input.cmd PR detection, the new nested hooks.state trust format), and cover integrity-audit finding 7.

SPECIFICS:
- Audit sections to read: finding 7, finding 20 (Codex/doctor parts only), the review of ranch-codex-task-reporting-fix-plan.md, and /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/5-shepherdr-task-comparison.md §3-§5.
- GATE: the audit says not to build a custom `plan` command only to remove it in the next design. Report 5 recommends option A (bundle reporting; this command fits it), but the person has not decided A vs B. Before any implementation, ask the person with AskUserQuestion: A (bundled reporting command, recommended) or B (native Herdr data only, no checklist). Stop if they choose B.
- Step 0 of the report (capture a real exec_command payload) needs Codex installed on this Mac. Check `codex --version`. If you can't capture it, build the fixture from the documented shape and mark it unverified. Never edit ~/.codex/hooks.json or config.toml. Ask the person to capture the payload if needed.
- Before rollout, the audit requires shared-session locking, resume preservation and child identity binding. Those are owned by tab 4 (integrity). Your `plan` command must call the existing store/reducer APIs so it inherits their fixes, and must not add its own locking or session adoption.
- Sandbox writable_roots: document it in RECIPE.md. Don't edit the user's config.

HOW TO WORK (mandatory):
- Follow the "Orchestrator protocol" in ~/.claude/CLAUDE.md exactly. Plan, delegate to Herdr sub-agent workers (hc run --bg, opencode, unique --session, ~10 s apart, project root = your worktree), and review every diff yourself before accepting it. Use the Ranch task list per ~/.claude/RANCH.md.
- Step 0: run `npm test` and `npm run check` in your worktree and record the baseline. Then check every claim and line number in the report against the actual code before planning. The reports were written on Windows against installed copies. Where the code disagrees with the report, trust the code and note the difference.
- Use systematic debugging and TDD: write a failing regression test for each bug before fixing it. The report's "Tests" / "Regression check" lists are the minimum.
- Edit the source lib/ (never only the mod copies); run `npm run sync` before tests.
- Never touch the live install or user config/data (~/.config/herdr-app/mods, ~/.herdr/ranch, ~/.claude, ~/.codex, ~/.config/opencode, shared agent instructions). Never run npm run reload, scripts/link-dev.sh, or ranch-tasks install/uninstall. Write live-data cleanups and instruction-file edits as proposals for the person.
- Stay inside your ownership (README table). If you need a change in a file or finding another tab owns, do not make it. Write it under "Cross-tab requests" in your final report.
- Decisions that are the person's (design choices, scope changes, anything that deletes or migrates data, security/permissions): ask with AskUserQuestion; don't guess.
- Do not commit or push unless the person asks in this tab.

DONE WHEN: every item you own is fixed with tests or explicitly deferred with a reason; `npm run verify` is no worse than the baseline (list any remaining failures, and say whether they existed before); and you have written /Users/ramanan/Projects/ranch/docs/fixes/12-11-2026/reports/2-codex-result.md. That file holds: what changed (file:line), tests added, verification output, deviations from the report, live-data/instruction proposals for the person, cross-tab requests, and open issues. Then summarise it in this tab.
