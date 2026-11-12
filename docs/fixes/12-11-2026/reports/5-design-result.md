# Fix set 5 (design): result

## DECISION (report 5 §4): **A: bundle reporting with Ranch, native fallback**

The person answered on 12-11-2026 in tab "fix 5: task design".
**For tab 2 (codex):** the bundled reporting command route stays and is not a throwaway. Build it on the shared, validated store semantics (with tab 4's shared-session lock and resume preservation, findings 2-6). Do not build a second writer with its own adoption or locking rules.

Worktree `~/Projects/ranch-worktrees/5-design`, branch `fix/1211-design`, base `bd639c6`. Nothing committed.

## Baseline (step 0, macOS, before any change)
- `npm test`: 272 tests, 272 pass, 0 fail. (The audit saw 9 failures on Windows; none happen on this Mac.)
- `npm run check`: passed for all 9 mods; layout/keys JSON valid.

## Checking the reports against the code
- **Audit 10 holds.** Both close controls checked only native `agents()`: `mods/ranch-sidebar/main.js:817-818` and `mods/ranch-topbar/main.js:230-231` (the report gives "the topbar close control" without a line number). The displayed status used `effectiveStatus` (`lib/format.js:178`), which falls back to hook activity.
- **Extra gap, not in the report, same finding:** the session panel showed `"idle"` for an agent whose Herdr status was null (`mods/ranch-session/main.js:151`: `status: p.status ?? "idle"`), while the Sidebar and Topbar showed that tab's hook working/blocked. Fixed under finding 10.
- **Second gap:** `effectiveStatus` uses `tab.status`, the most urgent of the tab's agents (blocked > done > working > idle). With one agent "done" and another "working" the tab reads "done". A close rule based on the tab status alone would therefore miss the working agent. The new rule checks every native agent first (test case b).
- **Native report fields:** local Herdr docs (`~/.config/herdr-app/herdr.d.ts:216-221`) only say "the agent's report in `report`". The field names `report.progress` (a 0-100 percent number) and `report.msg` were confirmed from Shepherdr's `mods/tasks/dot.js` `ownProgress()` at the pinned commit (read on GitHub; nothing installed). Shepherdr only checks `progress >= 0`, so non-finite values and values over 100 get through there; Ranch rejects or clamps them (below). `hc ls --json` does not include `report`.
- **Report §5 step 3 assumption:** Ranch has **no production layout installer** in this repo. The layout is only symlinked by `scripts/link-dev.sh`; the task runtime has its own installer and manifest (`adapters/install.js`, `~/.herdr/ranch/install.json`). "Move reporting into the ordinary package" therefore means first creating that package lifecycle (see the plan below).

## What changed
**Finding 10: one effective-status rule** (implementor worker U1, reviewed; one follow-up edit by me)
- `lib/format.js:187-231`: new `closeNeedsConfirm({tabId, tab, agents, panes, activity, now})`. The dialog shows if any native agent in the tab is working or blocked; else, when the tab has a native status, that status wins (as in the display); else the `effectiveStatus` hook fallback counts while fresh (≤30 min). Stale hook activity counts only when the tab still has an agent pane (`program.agent`), so a plain shell never counts as busy. New `closeConfirmProps(tabId, lastTab)` (dialog props that were duplicated in two files) and `agentStatus(nativeStatus, activity, now)` (one agent's display status, same rule).
- `mods/ranch-sidebar/main.js:817-825` and `mods/ranch-topbar/main.js:230-237`: both close controls use `closeNeedsConfirm` and `closeConfirmProps`.
- `mods/ranch-session/main.js:155`: the pane fallback keeps `status: null` (unknown) instead of a made-up "idle". `:168`: `session().status = agentStatus(chosen.status, ranch.activity[tab])`, which the main Tasks card's status pill uses (`:1710`). `:1711-1713` (my edit): list lifecycle still treats an unknown main status as idle, so stale done lists fade out exactly as before.

**Native activity baseline (report §5 step 2)** (implementor worker U2a, reviewed; wiring by me)
- `mods/ranch-session/model.js:46-88` (`nativeActivity` :56, `nativeActivityText` :72, `nativeFor` :85): `nativeActivity(terminal)` reads `report.progress` and `report.msg`. A missing percentage stays `null` (unknown); 0 stays 0; NaN, ±Infinity, negative and non-number values are rejected; values over 100 clamp to 100. The message has its whitespace collapsed, empty messages are dropped, and long ones are cut at 200 characters. It never mutates its input and is display only. `nativeActivityText()` gives "msg · 42%". `nativeFor(list, address)` uses exact address matching only, so `t3` never matches `mac/t3`.
- `mods/ranch-session/model.js:221`: the fallback empty text "This agent doesn't report tasks." becomes "No detailed steps reported for this session." (report §3). The setup and approval empty states are unchanged; they are step 5.
- `mods/ranch-session/main.js:1756-1759`: each open Tasks card (main and sub-agent) shows the native line under its header. It is matched by the card's exact terminal address from `terminals()`, shown with or without a checklist, and never written to any store. Checklist history is untouched.

## Tests added (written first; confirmed failing before implementation)
- `test/format.test.js`: `closeNeedsConfirm` cases a-j (native working/blocked; one done plus one working agent; an agent in another tab; native idle wins over fresh hooks; fresh hook working/blocked/done/idle with native status absent; stale working; stale blocked in a plain shell → no dialog; stale blocked with an agent pane → dialog; nothing at all; no tab object but a busy native agent). Also `closeConfirmProps` (last tab of a space vs. not) and `agentStatus`.
- `test/ranch-session-model.test.js`: `nativeActivity` (missing, 0, 100, 150 clamp, 12.5, NaN/Infinity/-Infinity/-1/"50"/null/true rejected, whitespace, length cut, nothing known), no mutation, `nativeActivityText`, `nativeFor` with exact and machine-qualified addresses. The two `taskEmptyState` assertions were updated for the new text.

## Verification (after all changes, run by me)
- `npm run verify`: tests 279, pass 279, fail 0 (272 baseline + 7 new); `check passed` for all 9 mods. No regressions; there were no failures before the change either.
- Every new import name was checked to resolve to an exported function (node import of `lib/format.js` and `mods/ranch-session/model.js`).
- **Not verified:** the rendering in a live Herdr window. That needs `npm run reload` or `link-dev.sh`, which the brief forbids. The person should open a tab whose Herdr status is empty while the hooks say working, and check that the close dialog appears and that the Session pill matches the sidebar.

## Deviations from the report / brief
- Native message and percentage are shown in the **Session** Tasks cards only. The Sidebar card and Topbar don't show them yet (report §3 asks for "one panel"; adding them to the sidebar card is a later UI choice).
- Values over 100 are clamped rather than rejected (§6 allows "rejected or safely clamped"; the brief only requires rejecting non-finite values).
- When Herdr reports "idle" for a tab, close protection follows that native status even if a hook says working. This keeps the dialog matching what the panel shows, which is the finding's stated fix.
- Delegation: two small edits were done by me rather than a worker (the `lifeStatus` line and the 5-line native wiring in `mods/ranch-session/main.js`). Both fall under the protocol's few-lines-in-one-file allowance.
- Worker incidents: worker U1 asked for `git stash && npm test; git stash pop`. That would have swept up the other worker's uncommitted edits into the shared stash stack, so I asked the person to reject it. No stash was created. U2a ended on an unneeded read-only prompt, so I reviewed and accepted its finished diff and stopped it.

## Plan for report §5 steps 3-6 (planned, not implemented)
Status: **planned only.** Each step needs the person's explicit go-ahead in this tab, given after its dependencies have landed on `main`:

| Step | Depends on |
|---|---|
| 3. One install lifecycle | tab 4 findings 2-6 (store locks, resume preservation, cross-session leakage, unreadable/future stores, safe installer cleanup) |
| 4. Bundled reporting contract for modern Codex | step 3 + tab 2's Codex route + tab 1's missed-turn reset (audit 13) |
| 5. Remove the separate Setup UI | steps 3 and 4 verified on a real install (Claude, Codex, OpenCode) |
| 6. Transition old stores and pointers | step 3; any data change needs a separately approved migration |

Fact found while checking (this macOS clone, `bd639c6`): **Ranch has no production layout installer.** The layout is only symlinked by `scripts/link-dev.sh`. The task runtime has its own installer (`bin/ranch-tasks` -> `adapters/cli.js` -> `adapters/install.js`) and manifest (`~/.herdr/ranch/install.json`). So "bundle reporting with the ordinary package" first means creating that package lifecycle; it is not a matter of moving one call.

### Step 3: one Ranch install/update/uninstall lifecycle (option A)
Files:
- `adapters/install.js`: split into (a) a **layout part**: copy `layouts/ranch.*` and `mods/ranch-*` into `$HERDR_APP_HOME`, plus the task runtime into `~/.herdr/ranch/bin`, all recorded in the existing manifest with a content hash per file; and (b) the existing **provider integration part** (hooks, rule files, OpenCode plugin/todo flag), now optional and listed for the person before anything is written (per agent: what changes, where, how to undo).
- `adapters/cli.js`: new `ranch install [--yes] [--no-integrations] [--agents ...]`, `ranch update`, `ranch uninstall`. Keep `ranch-tasks install|uninstall|status|gc` as compatibility aliases that call the same code for at least one release.
- `bin/`: add the `ranch` entry; keep `bin/ranch-tasks`.
- `scripts/link-dev.sh`: unchanged (dev route); document that it does not install integrations.
- `adapters/doctor.js`: health from the manifest's file hashes and the actual hook/plugin entries, per machine and provider (also tab 4's finding 20).
Order: manifest schema v2 (adds `layoutFiles`, `hashes`, `integrations{agent: {files, entries}}`), readable by both old and new code -> layout copy -> integrations behind a disclosure -> doctor.
Migration/rollback: an existing v1 `install.json` is read as "integrations installed, layout unmanaged", and nothing is rewritten until the next `ranch install`. Files changed since install (hash mismatch) are never overwritten or deleted: they are backed up and reported. Rollback = `ranch uninstall --keep-history` restores backups and removes only unchanged owned files. Task stores and pointers are never touched.
Acceptance (§6): a fresh install has no task-specific step; integration changes are disclosed, minimal and reversible; declining integrations still gives a useful panel (native activity, from this fix set); update/uninstall keep changed instructions/plugins and task history; tests use a temp HOME only (no real home/instruction files); Windows paths with spaces and remote Windows homes have explicit tests.

### Step 4: bundled reporting contract (with tab 2)
Files: tab 2's Codex command route (`adapters/codex.js`, `adapters/cli.js` subcommand), all routed through `adapters/store.js` with the shared-session lock from tab 4. Claude (`adapters/claude.js`) and OpenCode (`adapters/opencode-plugin.js`) producers kept for compatibility. Children (Herdr sub-agents / headless workers) write their own terminal store and never move the main session pointer.
Acceptance (§6): real contract fixtures for Claude, current Codex (exec-command) and OpenCode; two terminals writing one session keep both updates; resume in a new terminal keeps tasks, binding a different session does not inherit them; Codex sandbox denial and hook/plugin rejection have failure tests; missed-turn warnings clear (tab 1).

### Step 5: remove the separate Setup UI
Files:
- `mods/ranch-session/main.js`: delete `setUp()` (~l.482-503), `setUpRow`/`setupResultRow` (~l.1862-1890) and the `empty.setup` branch (~l.1763). `taskEmptyState` (`mods/ranch-session/model.js:160`) loses `setup: true`; "invalid"/"missing with adapter not installed" become a compact diagnostic line ("Task reporting failed: <reason> · see ranch doctor"), scoped by machine and provider.
- `mods/ranch-settings/main.js`: replace the task-reporting rows and Set up/Repair button (~l.88-99, 296-335) with a read-only status per machine/provider from `ranch doctor --json` (what is installed, from actual files).
- `RECIPE.md`: update the Settings and Session descriptions.
Order: only after step 3 and 4 pass on a real install; diagnostics land in the same change as the removal.
Rollback: a revert restores the buttons; no data involved.
Acceptance (§6): no Install/Setup button as the main task content; a genuine failure still shows a truthful diagnostic; native-only installs show "No detailed steps reported for this session" plus native activity.

### Step 6: transition old stores and pointers
- Read-compatibility only: the new reader keeps reading schema-1/2 stores and old pointers (`lib/tasks.js` `parseStore`, `storeCandidates`); nothing is rewritten on read.
- The old runtime in `~/.herdr/ranch/bin` is replaced only by `ranch install` (backup first) and never removed by default; `ranch-tasks uninstall` keeps working.
- GC (`ranch-tasks gc`, triggered from `mods/ranch-session/main.js` ~l.350-358) stays limited to tab 4's fixed ownership rules; no history rewrite or registry cleanup without a separately approved migration with a dry-run listing and a backup.
Acceptance (§6): existing stores still show after the upgrade; downgrading to the previous Ranch still reads them; uninstall/update never deletes task history by default.

## Live-data / instruction proposals for the person
- None from this fix set. No live install, hooks, instructions, task stores or settings were read for changes or modified. (`hc ls` and `hc read` were used read-only to check field shapes and worker screens.)

## Cross-tab requests
- **Tab 2 (codex):** decision A above. Route the Codex command through `adapters/store.js` with tab 4's session lock; children must not move the main session pointer (plan step 4).
- **Tab 4 (integrity):** steps 3-6 wait on findings 2-6. Finding 20 (diagnostics from actual installed files) is the basis for step 5's read-only status; please keep `ranch-tasks status --json` per-provider output stable, or tell this tab when its shape changes.
- **Tab 1 (bugs):** the missed-turn reset (audit 13) is a step 4 prerequisite. Nothing needed now.
- **Merge note:** this branch touches `mods/ranch-session/main.js` (`session()`, `tasksCard` head), `mods/ranch-sidebar/main.js` (`closeTab` only), `mods/ranch-topbar/main.js` (close handler only), `lib/format.js` (append only) and `mods/ranch-session/model.js` (append + one string). It is small and should rebase cleanly after tabs 1-4.

## Open issues
- Live UI not exercised (see Verification).
- Hook activity (`ranch.activity`) is per tab, not per agent. In a tab with several agents, an agent with no native status borrows the tab's hook state for its Session pill (the same as the Sidebar/Topbar today). Per-agent activity would need the namer to publish by address, which belongs to a later change.
- Sidebar/Topbar native message display is deferred (see Deviations).
- Steps 3-6 need the person's explicit go-ahead after tabs 4 and 2 land.
