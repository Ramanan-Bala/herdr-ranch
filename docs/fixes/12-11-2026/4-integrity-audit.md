<!--
Transcribed from "4. integrity-audit.pdf" (7 phone photos of
`herdr-ranch-integrity-audit-2026-11-12.md` open in an editor on a Windows machine).
Editor ligatures were written as ASCII (`=>`, `!==`, `===`, `->`).
Where a character could not be read with certainty it is marked [?].
-->

# Herdr Ranch: integrity, stability, logic and performance audit

**Date:** 12 November 2026
**Mode:** Read-only investigation. No Ranch code, hooks, task setup, installed mods or user configuration changed.
**Source:** `C:\Users\LH719EC\AppData\Local\Temp\opencode\herdr-ranch`
**Commit:** `bd639c660f1f52b1b9d29219e6589a9f4ed7d0c2`
**Installed mods:** `C:\Users\LH719EC\.config\herdr-app\mods\ranch-*`
**Task runtime:** `C:\Users\LH719EC\.herdr\ranch`
**Environment:** Windows; Herdr app 0.1.15; Herdr core 0.1.20; Node 24.13.1.

**Follow-up comparison:** `herdr-ranch-shepherdr-task-comparison-2026-11-12.md` explains Shepherdr's task handling and a proposed single-setup Ranch design. It is also read-only; no redesign was implemented.

## What this repo does

Ranch replaces Herdr's usual layout with a workspace sidebar, agent launch controls, a session/task panel, files and Git Changes panes, settings and usage indicators. Its task adapters write agent events into session files; terminal pointer files tell the UI which session to display. Git and GitHub results are collected asynchronously and used in several separate views.

**Load assumed:** one person with up to 30 tabs across three machines, including linked Git worktrees, slow/offline remotes, multiple agents and resumed sessions. This follows the repository's stated design load, not a hypothetical multi-user server.

## Executive verdict

**The layout renders, but its integrity is not yet strong enough to call healthy.** The most important problems are incorrect ownership of asynchronous workspace results, task-store data loss/isolation, destructive installer cleanup and outdated Codex task handling. Performance work matters, but should follow those correctness fixes.

There are **20 numbered findings** below, grouped into **Must fix** and **Should fix**. Closely related defects are grouped so each finding describes one repairable area. Findings distinguish direct reproductions, source-confirmed logic and risks that still need live stress testing.

**Your reported Git Changes workspace-sync bug is finding 1.** The three supplied pending plans are substantially justified, but none covers all the integrity problems found here. Their scope should be updated before implementation.

## Evidence and verification

| Check | Result and qualification |
|---|---|
| Source/installed comparison | Compared 219 candidate source/runtime/mod file pairs. Present adapter and mod counterparts matched byte-for-byte. Six general runtime library files are intentionally absent: the installer copies only the libraries its task runtime needs. Installed layout and OpenCode plugin were compared separately and also match source. |
| Repository state | `git status --porcelain=v1` remained empty; HEAD remained the commit above. |
| Existing automated tests | Ran 19 test files directly with Node, excluding `herdr-check.test.js`, whose module initialization runs library synchronization. **199 tests: 190 passed, 9 failed; exit 1; approximately 69 seconds.** This is not a passing suite. |
| Herdr eager checks | All nine mods printed `check passed`. Seven checks exited cleanly. Session and Usage printed success but their processes exceeded the 30-second runner timeout. Their runtime termination is therefore not verified. |
| Live status/frame | Live Ranch status reported `errors: []`; one screenshot was captured without switching layouts, toggling panels, moving tabs or resizing the user's window. |
| Targeted assertions | **11 in-memory assertions** confirmed specific failure behavior. Private writer/cleanup functions were evaluated with mocked filesystem operations, so these are focused logic tests, not real installation/concurrency tests. No source files or live configuration were written. |
| Existing test log | `C:\Users\LH719EC\AppData\Local\Temp\opencode\ranch-audit-tests.log` |
| Live frame | `C:\Users\LH719EC\AppData\Local\Temp\opencode\ranch-audit-live.png` |

The 11 targeted checks covered modern Codex tool omissions, cross-session task/PR retention, a stuck missed-turn counter, duplicate Stop counting, literal-arrow filename parsing, global `gh -R` detection, lookalike GitHub host classification, remote-only default-branch discovery, Changes context retention while loading, destructive `RANCH.md` cleanup and the OpenCode first-event session overwrite path.

### Existing test failures: what they mean

- Four test files fail to import Windows drive-letter paths as ESM URLs: session model, session Windows, sidebar model and Usage. Use `pathToFileURL(path).href` instead of importing a raw `C:\...` path. These tests never reached their assertions.
- Two OpenCode instruction/context assertions expected two system parts but got one. The plugin checks the real `homedir()` instruction file while tests isolate most other paths through `RANCH_HOME`; this machine already has the marked instruction block. Tests are contaminated by host configuration.
- Two installer assertions exercise simulated POSIX output on Windows but receive platform-native backslashes. One integrity reinstall assertion has a related serialized matcher/path expectation mismatch. The synthetic platform parameter does not make Node's native `path.join` POSIX.
- These failures expose verification gaps. They do **not** show that all nine failures are live UI defects, and they do **not** excuse the independently reproduced product bugs.

## Must fix

### 1. Git Changes can keep showing the previous workspace

**Where:** `mods/ranch-changes/main.js:5-10,63-75,101-113,178-181`.

- **What this is:** The Changes pane derives its location from the focused pane/terminal and the active space, then reads Git status and a file diff asynchronously.
- **Problem:** `refresh()` returns immediately when `loading` or `busy` is true, **before checking whether the context changed**. Switch A to B during A's Git read: A's files, diff, root and commit message remain visible in B. A's stale read is rejected at completion, but the latest B context is not queued immediately; absent a new render/watch event, the next scheduled retry can be 10 seconds away. An in-memory call to the actual method confirmed that B still displays A's file list and retains A's context while loading.
- **Fix:** Check and invalidate context before the busy/loading guard. Clear or hide data that does not belong to the current context; mark the latest context pending; after the old request finishes, start that pending request immediately. Give requests an ownership token so an old completion cannot clear a newer request's loading state. Keep the existing commit-time context guard.
- **If we skip it:** The pane stays misleading during ordinary tab changes and slower remote reads. The existing commit guard blocks a stale-context commit; this finding does **not** claim a reproduced wrong-repository commit.

**Regression check:** Hold A's status or diff promise open, switch to B, render, and verify no A data/message is displayed as B. Resolve A; B must fetch immediately and remain authoritative. Repeat with A's commit in progress, no-folder B, a remote B and rapid A->B->A switching. Separately decide whether the intended scope is the workspace root or the focused shell's current repository; the current code chooses the latter and should identify it visibly.

### 2. Resuming OpenCode in a new terminal can erase saved tasks

**Where:** `adapters/opencode-plugin.js:459-524`; compare `adapters/store.js:266-285`.

- **What this is:** The OpenCode plugin should reconnect a new terminal to an already saved session.
- **Problem:** With no terminal pointer or legacy file, the plugin starts from an empty store and adopts the incoming session ID, but never loads the existing `sessions/<id>.json`. It then writes the empty/adopted store over that file. A mocked-filesystem execution of the actual writer reduced a saved store from sequence 42 with a task to sequence 1 with no tasks.
- **Fix:** Resolve the incoming main session before reducing the event; if that session already exists and belongs to OpenCode, load it under the session lock. Preserve its sequence and content, and refresh the new terminal's identity separately. Do not adopt child-session events as the main session.
- **If we skip it:** Reopening/resuming a session can destroy the history that the session-keyed layout was introduced to preserve.

**Regression check:** Prepopulate a session with tasks and a sequence number; resume it in a new terminal using an idle/title event, not a replacement todo event. Tasks and sequence must survive. Repeat for child events, another agent's store, missing session files and malformed stores.

### 3. The store locks protect terminals, not the shared session being written

**Where:** `adapters/store.js:228-317`; `adapters/opencode-plugin.js:468-520`.

- **What this is:** Multiple terminal pointer files can refer to one session file. A lock is a small file used to prevent competing writers from updating the same document at once.
- **Problem:** Both implementations lock `terminals/<terminal>.json` but write `sessions/<session>.json`. Two terminals resuming the same session have different locks: each can read sequence N, calculate N+1 and overwrite the other result. `Math.max(current.seq,next.seq)+1` only compares the already-read snapshot; it does not reject a newer value written by another process. The session store also holds one terminal identity, so concurrent readers can disagree about whose start time it represents.
- **Fix:** Lock the actual session path for session-backed updates, re-read it inside that lock and increment from the locked latest value. Establish one consistent lock order if both pointer and session locks are needed. Keep terminal start identity in the pointer/read context rather than allowing one resumed terminal to invalidate another's session data. Make child/headless agents unable to rebind the parent's main pointer.
- **If we skip it:** Concurrent hooks can lose tasks or PR records despite atomic file replacement. Nested agents inheriting `HC_TERMINAL_ID` can also overwrite the parent's session binding.

**Regression check:** Coordinate two writers so both attempt to append to one session from different terminals. Both changes must survive and sequence must rise twice. Add a nested-agent test that preserves the main pointer. These process-level races were source-reviewed, not run against the live store.

### 4. A new session can inherit the old session's tasks and PRs

**Where:** `adapters/codex.js:65-93`; `adapters/claude.js` session-start/session-change branches; `adapters/opencode-plugin.js` session reset paths.

- **What this is:** A terminal may start, clear or resume different agent sessions over its lifetime.
- **Problem:** Claude and Codex reset only parts of the session data. A different `source: resume` ID can retain A's tasks/subagents under B's session; clear/startup paths retain old PRs and missed-turn counters. The targeted Codex assertion reproduced B receiving A's task and PR. OpenCode also does not consistently reset the warning counter when changing main sessions.
- **Fix:** Separate "resume this same session" from "bind a different session." Load B's existing store if it exists; otherwise create B from a complete empty session-scoped document. Reset tasks, subagents, PRs, turn state and warning counters together for a genuinely new session; preserve them only for the same session.
- **If we skip it:** The wrong work and PRs appear under a new conversation, and warning history follows unrelated work.

**Regression check:** For all three adapters, cover same-session resume, different-session resume, clear, startup, compaction and ID changes without SessionStart. Include PRs and warnings, not just tasks.

### 5. Writers and garbage collection can destroy stores that should be preserved

**Where:** `lib/tasks.js:173-214`; `adapters/store.js:85-105`; `adapters/opencode-plugin.js:78+`; `adapters/install.js:1029-1094`.

- **What this is:** Readers reject a future schema version; cleanup removes old files.
- **Problem:** Writer-side readers turn a rejected future-version or unreadable store into an empty document and then overwrite it with schema 2. Cleanup deletes a session after 14 days solely by modification time, without protecting sessions referenced by live terminal pointers; an old live pointer can also be deleted. Malformed shared PR registry reads can similarly become an empty registry before an update.
- **Fix:** Make "missing," "unreadable," "invalid" and "newer schema" distinct writer outcomes. Never overwrite unreadable/newer data; quarantine invalid data before replacement and surface an error. During GC, collect live pointers and protect their referenced sessions; do not perform destructive cleanup when liveness cannot be established safely.
- **If we skip it:** Downgrades, permissions/AV errors, corruption or a long-idle live session can remove recoverable data automatically.

**Regression check:** Verify byte preservation for future versions and read errors; verify quarantine for invalid JSON. A live 15-day-old session and pointer must survive GC. Use an isolated filesystem, not the user's active task directory.

### 6. Installer cleanup is not safe for user-edited instructions/plugins

**Where:** `adapters/install.js:615-657,733-824`; hook group stripping helpers.

- **What this is:** Task setup edits global agent files and promises to remove only Ranch-owned content.
- **Problem:** Installation overwrites an existing `.claude/RANCH.md` without backing it up. Uninstall treats that whole file as removable regardless of its current content: the mocked cleanup reproduced an existing custom instruction file being blanked. A Ranch-created file with later user additions can be deleted completely. OpenCode plugin uninstall deletes any file containing the marker instead of safely restoring a prior/user-edited version. Mixed hook groups can lose non-Ranch commands when an entire group is identified as Ranch-owned.
- **Fix:** Back up every pre-existing file before replacement; record the exact installed bytes or hash. Restore an original only when the current file is still the version Ranch owns. If edited, remove only a clearly delimited owned block or leave the file and report the conflict. Strip individual Ranch hooks, not an entire mixed group. Use matching backups for byte-exact restoration.
- **If we skip it:** Setup/removal can erase unrelated instructions or plugin/hook customizations. Do not use uninstall/reinstall as a casual migration shortcut.

**Regression check:** Pre-existing custom `RANCH.md`; user edits after installation; existing custom plugin; mixed hook group; CRLF files; repeated install/uninstall. Each unrelated byte should survive or an explicit conflict should be returned.

### 7. Current Codex task handling targets an obsolete tool contract

**Where:** `adapters/install.js:24`; `adapters/codex.js:106-122`; `adapters/instructions.js:9-13,68-77`; `lib/prs.js`; `adapters/install.js:886-1018`; `adapters/doctor.js:23-29,118-125`.

- **What this is:** Codex's hook matcher, reducer, reminders, trust checks and doctor must agree with the actual installed Codex tool/API shapes.
- **Problem:** The supplied plan records that Codex 0.167.1 no longer provides the old `update_plan` contract. Ranch still instructs agents to call it, matches only `update_plan|Bash|shell`, and ignores `exec_command`/`tool_input.cmd`. The old synthetic doctor event can pass without current Codex producing tasks. Trust parsing recognizes old flat `[hooks.state]` entries, not the supplied newer nested entries and hashes; absence of recognized trust entries is not proof of approval.
- **Fix:** Implement one supported reporting route for current Codex, with matching instructions, matcher, reducer/CLI, PR command parsing and a real current-version fixture. Keep legacy support if needed. Parse and validate the actual nested trust format without silently changing approval or sandbox permissions. The user-requested Shepherdr comparison must inform whether a custom reporting CLI is still needed.
- **If we skip it:** Hooks may appear installed while tasks never update; the diagnostic can give false reassurance.

**Regression check:** Actual `exec_command` payload; old `update_plan`; multiline arguments; rejected/malformed plan; approved/unapproved/changed-hash nested trust; writable-root failures. A terminal-type guard alone does not solve a child agent already rebinding the parent pointer.

### 8. Shared PR records can be filed under the wrong repository and branch

**Where:** `adapters/cli.js:105-111`; `lib/prs.js`; `mods/ranch-sidebar/main.js:252+`; `mods/ranch-session/main.js:1562+`.

- **What this is:** Own-session PR history records what the agent created; the shared registry is meant to show PRs belonging to a particular checkout/branch.
- **Problem:** Registry ownership comes from `payload.cwd` and the checkout's current branch, not the PR's actual repository/head. A command can change directory or use `gh -R`/`--head` and file a profile-api PR under forms-render. The supplied real example fits this code path. Global `gh -R owner/repo pr create` is not detected at all; `cmd` is omitted, and command/output scanning does not reliably identify the successful create result. Sidebar number-only dedup and Session row IDs based on PR number also collide for valid foreign-repository PRs with the same number.
- **Fix:** Resolve effective command cwd, explicit repository/head and the returned PR's owner/repo/head before sharing it. If ownership is uncertain, keep the creator's own-session record but do not put it into the shared checkout registry. Add a repository match guard to registry reads only. Use canonical URL/repository identity for dedup and row IDs. Clean existing polluted records only with approval.
- **If we skip it:** Unrelated PRs and CI status appear in the wrong workspace; legitimate records may be dropped or not captured.

**Regression check:** Cross-repo `cd`, Git Bash `/c/...`, `gh -R`, tool workdir, `--head`, failed command output, multiple PR URLs, and the same PR number in two repositories. Do not filter foreign PRs out of the creator's own-session history.

### 9. Session Git/PR results and actions are not fully bound to the current context

**Where:** `mods/ranch-session/main.js:509-620,625-690,913-983,1068-1081,1184-1190`.

- **What this is:** The Session panel has one Git slot and one PR slot while the user changes machines, folders and branches.
- **Problem:** Switching folders marks data dirty but does not immediately invalidate the in-flight operation's ownership key. A late A PR can populate the slot after B clears it; the action bar reads `this.pr.parsed` without `prReady()`. PR readiness is checked by machine/folder, not branch, so a branch change within one folder can display the prior branch's PR until another lookup completes. Push captures the current machine alongside an unguarded stored Git root, and reset busy/result fields can be affected by a late old operation.
- **Fix:** Capture one immutable `{machine,cwd,repoTop,branch,generation}` context for each read and action. Apply results only to their owning context/cache entry; invalidate readiness immediately on switch. Guard every link/action with the full current key, including branch for PRs. Capture push context once and do not let an old completion reset a new operation's state.
- **If we skip it:** PR buttons can point at another workspace/branch, and asynchronous action state can be misleading. A live wrong-repository push was not executed or reproduced during this audit.

**Regression check:** Deferred A Git/PR result after B selection, same-folder branch switch, local->remote switch and overlapping push completions. Cache changes must not introduce cross-context display.

### 10. Closing a tab can bypass the warning for a working agent

**Where:** `mods/ranch-sidebar/main.js:817-828`; `mods/ranch-topbar/main.js` close control; `lib/format.js` effective status logic.

- **What this is:** Ranch combines Herdr's native agent status with fresh adapter activity so the UI can still show working/blocked when native status is absent.
- **Problem:** The close confirmation checks only native `agents()` status. If the card is working/blocked because of fresh hook fallback but native status is empty/idle, the tab can close without the warning and terminate that agent.
- **Fix:** Use the same freshness-aware effective status and agent/pane fallback for both display and close protection. Do not classify a normal shell as an agent solely because stale activity exists.
- **If we skip it:** A card can visibly say it is working while its close control silently kills the terminal.

**Regression check:** Native status absent with fresh hook working/blocked, stale hook state, multiple agents, a plain shell and the last tab of a space.

### 11. A requested worktree can silently turn into a normal launch

**Where:** `mods/ranch-launch/main.js:125-128,151-161,167-185`.

- **What this is:** The launch dialog offers isolated Git worktree execution.
- **Problem:** `if (!this.worktree || !this.repoTop)` launches a normal tab. If worktree mode was selected or remembered but the repository probe has not completed, `repoTop` is empty and the launch silently uses the ordinary folder instead. That is an isolation failure, not just a missing loading indicator.
- **Fix:** Do not launch while worktree detection is pending. If worktree mode is requested but no usable repository/home exists, show a clear error or require an explicit normal-launch choice. Keep the plain-tab route only when worktree mode is off.
- **If we skip it:** An agent the user intended to isolate can edit the shared checkout.

**Regression check:** Press Enter before the Git probe resolves; remembered worktree preference in a non-repository; failed remote home probe; unavailable branch; closed dialog during worktree creation. No cleanup should delete a user-populated worktree.

### 12. Corrupted persisted UI state can break layout controls

**Where:** `mods/ranch-topbar/main.js:30-32,99-122`; `mods/ranch-sidebar/main.js:80-85`.

- **What this is:** Local storage holds per-space panel choices and collapsed sidebar maps.
- **Problem:** Topbar parses saved JSON without a catch or shape check. Invalid JSON fails initialization; JSON `null` fails later object use. Sidebar catches malformed JSON but shallow merging allows inner maps such as `m: null`, which later indexing assumes are objects.
- **Fix:** Use small object-shape checks at these two read boundaries; fall back to empty maps and validate stored panel IDs. Do not add a new storage framework.
- **If we skip it:** A damaged/stale saved value can prevent controls or the sidebar from rendering until manually reset.

**Regression check:** Invalid JSON, `null`, arrays, strings, wrong-shaped inner maps and unknown panel IDs. Preserve usable neighboring values.

## Should fix

### 13. Missed-turn warnings stick forever, and rename instructions target focus instead of ownership

**Where:** `adapters/codex.js:96-132`; `adapters/claude.js` Stop/task update paths; `adapters/opencode-plugin.js:265-325`; `adapters/instructions.js:68-77`; shared agent instructions named in the supplied bug plan.

- **What this is:** Missed-turn counters remind an agent to report tasks; tab naming should address that agent's own terminal/tab.
- **Problem:** A valid task update does not reset the missed-turn count. Claude/Codex Stop tracking can count the same turn more than once; OpenCode busy activity is treated as work even for pure questions and interrupted/failed runs. Separately, the supplied global tab-rename procedure reads the focused Herdr tab, which may belong to the user or another agent rather than the caller.
- **Fix:** Consume each turn once and reset the warning after a valid task report. Define work/interruption handling consistently; do not hide genuinely missed work solely because an old in-progress task exists. Resolve rename target from the caller's terminal `herdr.tab` label, not focus; skip parent/tab renaming for children and handle remote-qualified identity.
- **If we skip it:** Reminder badges and prompts remain noisy after recovery, and an agent can rename the wrong tab.

**Regression check:** Miss->valid report->no warning; duplicate Stop; pure Q&A; interruption/continuation; caller tab differs from focused tab; child/remote caller. Counter defects were directly reproduced; the global instruction defect is confirmed by the supplied procedure and ownership mismatch.

### 14. Repeated watchers, unbounded caches and independent collectors undermine the load budget

**Where:** `mods/ranch-session/main.js:546-562,700-752`; `mods/ranch-sidebar/main.js:37-42,139-174,277-307`; `lib/git.js:353+,443-459`; `mods/ranch-sidebar/namer.js`; `mods/ranch-usage/main.js` collector lifecycle.

- **What this is:** Folder watchers wait for changes; caches retain recently fetched results; background collectors launch external processes.
- **Problem:** Session starts a new watch loop on every Git refresh; changing a generation does not wake an older pending `watchFolder()` await. Sidebar watch membership can be removed/re-added while an older wait remains. TTL cache expiry does not delete entries; `topOf` and several naming maps are not pruned. Session recorded-PR lookups start per URL without the sidebar's four-job limit, and sidebar Git refreshes have no global queue. Separate/hidden layout copies retain timers, so a per-view limit is not a global limit.
- **Fix:** Keep one watcher lifecycle per active local root and avoid recreating it on ordinary refresh. Use entry identity/generation when reactivating roots; use a native cancellation facility only if available. Bound/prune caches, serialize work per canonical repository and enforce a shared bounded PR queue across collectors. Do not fan out polling to every cached repository. Expired cache reads should remove expired entries.
- **If we skip it:** Long sessions and many tabs can accumulate pending waits, memory and process/network bursts beyond the repository's stated one-Git-per-repo/four-GitHub-process budget.

**Regression check:** Count watcher registrations after 100 refreshes; close/reopen the same root; expire many unique cache keys; 30 tabs/three machines; multiple hidden view copies; assert process bounds. This is source-confirmed lifecycle behavior, not a measured memory leak or production load benchmark.

### 15. Tab switching still repeats a long serial Git pipeline

**Where:** `lib/git.js:226-319`; `mods/ranch-session/main.js:509-542,625-690`.

- **What this is:** The Session panel fetches repository metadata, branch divergence, file totals and recent commits.
- **Problem:** Independent Git calls run serially, while only the current result slot is retained. Returning to a recently viewed workspace incurs the same cold pipeline and shows Refreshing instead of its own cached result. The supplied plan's approximately 5.8-second Git measurement is historical evidence from that plan, not a fresh benchmark performed here.
- **Fix:** First implement a bounded in-memory cache keyed by machine/folder and PR machine/folder/branch. Show that context's cached data as Updating and send late results to their own cache entry. Then reduce process count using porcelain-v2 branch metadata, combined repository path queries and short-lived metadata caching; parallelize only independent reads within a small bound. Preserve cancellation/ownership guards from finding 9.
- **If we skip it:** The panel remains slow during ordinary workspace hopping, particularly with Windows startup cost and remote latency.

**Regression check:** Warm A->B->A uses A's data immediately; branch changes invalidate PR ownership; cache eviction is bounded. Measure cold/warm timings on this machine before claiming a speed target. A ≤2.5-second target in the plan is a target, not an achieved result.

### 16. An offline/non-repository lookup can permanently disable sidebar Git discovery

**Where:** `mods/ranch-sidebar/main.js:104-136`; `lib/git.js:164-179,226-229`.

- **What this is:** Sidebar maps each machine/cwd to a repository root to avoid repeating discovery.
- **Problem:** Timeout, unreachable machine and genuine non-repository all collapse to `null`. `topOf` stores that null, and scheduling treats the location as already known rather than retrying discovery. A remote that later reconnects, or a folder later initialized as a repository, can remain without Git data until view recreation or another explicit invalidation.
- **Fix:** Distinguish failure from a successful "not a repository" result. Give negative results a short expiry/backoff and retry wanted locations; clear mappings on reconnect/root changes. Keep last-good summaries visibly stale during transient failure.
- **If we skip it:** Offline recovery is inconsistent and workspace badges can stay absent after the underlying repository becomes available.

**Regression check:** First discovery times out, second succeeds; folder becomes a repo; remote reconnects; repeated failure is bounded rather than retried every frame.

### 17. Remote Windows and remote session-usage handling are inconsistent

**Where:** `mods/ranch-sidebar/main.js:213+`; `mods/ranch-sidebar/namer.js` home/store reads; `mods/ranch-launch/main.js:125-128`; compare `mods/ranch-session/main.js` Windows home fallback; `mods/ranch-usage/main.js` session read; `mods/ranch-usage/helpers/session.mjs:29-33,42-64`.

- **What this is:** Features need the selected machine's home and agent session identity.
- **Problem:** Sidebar, naming and Launch depend on `sh` for remote home lookup; Session already has a Windows `cmd` fallback, so a remote Windows machine without `sh` has inconsistent features. Session usage runs local helpers against the selected terminal's PID rather than an explicitly machine-scoped reader; a remote PID is not a globally unique identity. Codex per-session usage still requires `pgrep`/`lsof` through the shell helper, unavailable on ordinary Windows even though a Node wrapper exists.
- **Fix:** Reuse one verified machine-aware home strategy with Windows fallback and failure backoff. Run session readers on their owning machine or clearly mark remote session usage unsupported. For Windows Codex, implement a real supported session lookup or show unsupported instead of implying that the wrapper makes it portable.
- **If we skip it:** Remote Windows loses registry/naming/worktree features, and remote or Windows session usage can be absent or associated using the wrong local identity. A real PID collision was not reproduced.

**Regression check:** Windows without Git Bash, POSIX remote, offline remote, identical PID values on local/remote machines, and missing Codex process tools. Provider account limits may deliberately remain local; distinguish them from per-terminal session numbers.

### 18. Shared Git parsing mishandles valid paths and incomplete default-branch metadata

**Where:** `lib/git.js:30-55,98-128,139-155,203-218,308-313`.

- **What this is:** The shared helper parses Git file statistics and constructs repository/branch links.
- **Problem:** Text numstat parsing treats literal ` => ` in a filename as a rename and does not decode Git's quoted/escaped paths. A direct assertion reproduced the wrong filename. With no `origin/HEAD` and only `origin/master` present, default discovery checks local `main/master` only and returns null; a direct fake-runner check confirmed this. Host classification also accepts `github.com.example.test` as GitHub, and compare refs are not URL-encoded.
- **Fix:** Read numstat with `-z` and parse its documented rename/non-rename format without guessing from filename punctuation. Probe known remote refs as well as local defaults. Parse hostname exactly for supported public hosts, preserving explicitly supported self-hosted behavior, and encode compare refs. Do not add a general Git parsing dependency for these small contracts.
- **If we skip it:** File links/statistics are wrong for legal filenames, feature-only clones can have no default comparison, and repository links can be misclassified or malformed.

**Regression check:** Unicode, tabs/newlines/quotes/literal arrows, renames, binary files; remote-only main/master, detached/unborn HEAD, unsupported/lookalike hosts and refs containing URL-significant characters.

### 19. The independent sidebar settings are coupled accidentally

**Where:** `mods/ranch-sidebar/main.js:934+` decoration/PR gating; `lib/settings.js` card options.

- **What this is:** "Show diff statistics" and "Show PR" are separate settings.
- **Problem:** PR decoration is gated by both `card.line3` and `card.pr`. Turning off the diff line removes PR badges even while Show PR stays enabled, including related worktree decoration.
- **Fix:** Gate PR data and badge rendering on the PR option independently. Use the diff option only for diff statistics/layout that truly belongs to that line.
- **If we skip it:** Settings do not do what their labels promise.

**Regression check:** All four combinations of diff on/off and PR on/off for ordinary cards, grouped tabs and worktrees. This is a source-confirmed logic defect.

### 20. Diagnostics and tests can report health without validating the actual running contract

**Where:** `adapters/install.js:41+,831-974`; `adapters/doctor.js:118-125`; `adapters/opencode-plugin.js:412-417,525-527`; `mods/ranch-settings/main.js` health/version loaders; tests listed above.

- **What this is:** Settings and doctor tell the person whether task reporting and dependencies are healthy.
- **Problem:** Drift detection compares only `cli.js` when run from the repo, not all adapter/plugin/library bytes or the required matcher contract. A matching command group or old synthetic event can report installed even when current Codex does not work. Doctor marks approval as a passing informational check rather than verified/unknown. Settings loads some health data only at initialization; OpenCode errors are silently swallowed without the CLI adapters' health/error evidence. The current test suite is also failing before four UI model suites execute.
- **Fix:** Compare an explicit installed manifest/hash set, required hooks and supported payload contracts; separate healthy, unhealthy and unknown/not-verified states. Refresh displayed health at a bounded interval or on real changes; log OpenCode reporting failures without breaking the host. Fix Windows imports and home isolation, then rerun all tests and asynchronous/UI context tests. Do not silently approve hooks or expand sandbox permissions.
- **If we skip it:** The person sees reassuring Setup/health status while tasks are missing, outdated or failing silently.

**Regression check:** Change only a reducer/plugin/library; remove only a required matcher; unapproved nested Codex trust; real instruction file differs from isolated test home; live health advances after new events; helper failure/nonzero version command; all Windows model suites execute.

## Coverage by component

| Component | Audit coverage and main outcome |
|---|---|
| Layout, key bindings, mod metadata | Reviewed layout topology and declared IDs, panel stack/defaults, entry points and repository requirements. No obvious missing mod/stack target found. AltGr/keybinding tradeoff is already documented and was not relabeled a bug. |
| Chrome/topbar | Read entry points. Propagation handling for draggable header controls is deliberate; close protection and persisted state are weaker than display logic. Live normal-width frame renders. |
| Sidebar/namer | Read entry points and naming coordinator. Reviewed grouping, Git/PR queues, collapse state, activity fallback, rename ownership, cache lifecycle and remote home handling. |
| Session/tasks/subagents | Read the full entry point, task contract and adapter write paths. Main task reads have generation checks; Git/PR/actions and some child-task reads do not consistently use equivalent ownership. Child read results should validate current parent, entry identity and machine before publication. |
| Settings/setup/doctor | Read installation/cleanup and doctor paths. Safety and health detection findings are above; no setup/install/uninstall/GC was invoked on the live user installation. |
| Launch/worktrees | Read entry point and traced launch options/context. Isolation must not silently fall back during detection. |
| Files | Read frozen clone. Output/preview limits and context checks exist. Folder enumeration/expanded-folder polling and pending watch lifecycle need load measurement; no file write feature was exercised. |
| Changes | Read full frozen clone. Confirmed context/busy ordering defect. Diff list is virtualized, status is NUL-delimited, and reads disable optional Git writes; these are good safeguards. |
| Usage | Read entry point and Node helpers, examined provider contracts and test results. Last-good/failure presentation has deliberate separation, but reader machine ownership and multi-view collector lifecycle need work. Not every provider/parser/shell helper was reviewed line-by-line. |
| Shared libraries/tests/build scripts | Deep review of task, PR and Git contracts; reviewed relevant settings/naming callers and tests/build checks. No new dependency needed for the recommended corrections. Copied libraries create synchronization burden; treat the source library as authoritative. |

### Additional safety/design notes, not extra numbered findings

- **Changes commits the whole repository:** it always runs `git add -A` before `git commit`, even though the list is capped at 1,000 files. This is the shipped clone's behavior, not a reproduced synchronization write bug. The UI should explicitly say "Commit all changes" and warn when truncated; changing selection/staging semantics is a separate product decision. Failed commits leave the newly staged index intact. Do not automatically roll it back while other agents may be editing.
- An old subagent read can target a map entry recreated for a new parent/context. Apply the ownership discipline from finding 9 to child task publication as well.
- Per-space remembered panel names and several sidebar/naming maps can retain closed-space entries. Include them in lifecycle pruning from finding 14.
- The normal-width screenshot does not prove narrow-window, high-DPI, keyboard-scroll or remote layout correctness. Potential clipping and off-screen keyboard selection need dedicated UI validation, not a confident bug claim from static dimensions alone.
- Windows URL-opening/child-process lifetime deserves explicit argument/process-tree testing. No command-injection exploit or runaway child tree was established here; these were not presented as proven vulnerabilities.
- Documentation is stale in places: the repo has nine mods and substantial tests; the caching plan's "no tests" claim is false for this checkout. Store paths/schema and Codex tool descriptions also need updating with the eventual repair.

## Review of the three supplied pending plans

### `herdr-ranch-session-git-caching.md`

**Keep:** bounded in-memory cache first, then fewer Git processes; do not add disk caching or poll every cached repository.
**Add:** current ownership tokens, branch-aware PR readiness, guarded action-bar links/push, watcher lifecycle and shared queue bounds. A cache is not a fix if it can show another context's data.
**Correct:** tests already exist; the timing and ≤2.5-second target have not been re-measured/achieved during this audit.

### `herdr-ranch-bugs-and-fixes.md`

**Keep:** separate creator-session PR history from shared repository/branch ownership, use the caller's own tab identity, reset missed-turn warnings.
**Add:** actual command repository/head resolution, global `gh -R`/`cmd`, URL-based row identities, duplicate Stop consumption and complete session reset. Registry cleanup needs approval and must preserve creator history.
**Caution:** "only warn when no in-progress task exists" can hide genuine missed reporting; turn semantics need tests rather than a blanket suppression rule.

### `ranch-codex-task-reporting-fix-plan.md`

**Keep as a fallback design:** validated reporting through one current Codex route; real exec-command fixture; correct nested trust/hash handling; no silent sandbox expansion.
**Add before rollout:** shared-session locking, resume preservation, child identity binding, safe installer/removal migration and truthful diagnostics.
**Revisit after Shepherdr comparison:** if tasks can be read directly from agent-native data with acceptable limitations, a separate reporting CLI/setup may be unnecessary. Do not implement a custom plan command merely to remove it in the next design.

## Smallest sensible repair sequence - recommendations only

1. **Protect data first:** findings 2-6. Add isolated regression tests for resume, cross-session resets, shared-session writes and user-edited cleanup. Do not run GC/migration against live data until these rules are proven.
2. **Fix workspace ownership:** finding 1, then 8-11. One consistent current-context contract should govern display, asynchronous completion and action execution. Keep changes incremental rather than replacing the whole UI.
3. **Choose task ingestion after Shepherdr review:** finding 7 plus the requested no-separate-setup goal. Preserve subagent/session identity; approval and writable-root limits cannot simply be hidden.
4. **Fix warnings/settings/verification:** findings 12,13,19,20; make the Windows suite execute reliably.
5. **Make it fast without creating more collectors:** findings 14-18. Measure cold/warm switching and concurrency before and after each change.

No implementation, configuration migration, registry cleanup, dependency addition or installation is authorized by this report.

## Limits and unchanged state

- Read all nine main mod entry points and the high-risk adapter/store/install paths. This was an end-to-end, risk-based whole-layout audit, not a claim that every asset and provider helper line was inspected.
- Did not change the user's layout, selected workspace, panel choice, hooks, instructions, permissions, task runtime or repository files. The audit tab alone was renamed to "Ranch integrity audit" at the start after verifying it belonged to this terminal.
- Existing tests were run without the test module that synchronizes copied libraries. The suite failed as documented; no failures were hidden or fixed.
- No live commits, pushes, PR creation, worktree creation, installs, uninstalls or task-store cleanup were performed. No remote-machine load test, prolonged memory soak, cold-Git benchmark or interactive A/B workspace stress run was performed.
- The source/installed equality check rules out an obvious old installed mod as the cause; it does not prove the host's deferred/asynchronous rendering paths are correct.

**Verdict:** Fix workspace/result ownership and task-store/installer data safety first. Ranch currently renders, but is not integrity-clean or fully verified.

**Not checked:** long-running multi-machine load, real concurrent store races, narrow/high-DPI UI behavior, every Usage provider/helper variant and actual current Codex approval/execution. No code fixes applied.
