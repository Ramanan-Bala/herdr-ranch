<!--
Transcribed from "5 .shepherdr-task-comparison.pdf" (3 phone photos of
`herdr-ranch-shepherdr-task-comparison-2026-11-12.md` open in an editor on a Windows machine).
Editor ligatures were written as ASCII (`=>`, `->`).
-->

# Ranch tasks: Shepherdr comparison and a single-setup design

**Date:** 12 November 2026
**Mode:** Read-only research and recommendations. No code, hooks, plugins, configuration, installations or task data changed.
**Companion audit:** `herdr-ranch-integrity-audit-2026-11-12.md`
**Ranch source:** `bd639c660f1f52b1b9d29219e6589a9f4ed7d0c2`
**Shepherdr source inspected:** `ef3be074dd3e28942149b7a5183ab2e2d4207954`, from the supplied GitHub repository. Its README identifies the release as 3.1.33.

## Outcome

**Borrow Shepherdr's integrated packaging, explicit task ownership and native progress display-not its whole task orchestration system.** Ranch can remove its separate Tasks installation/setup workflow while keeping detailed checklists, by delivering reporting as part of the ordinary Ranch layout installation. Herdr's native status/progress can make the panel useful even when detailed reporting is unavailable.

There is an important limit: **Shepherdr does not obtain every agent's complete checklist without a producer.** Its project tasks are records written through its own bundled `herdr-task` command. Native Herdr progress supplies a percentage/message when an agent emits them, not a complete list of steps.

Your later instruction, **"!!no code changes!!"**, applies to this comparison too. Everything below is a proposed design, not an implementation or an instruction to install Shepherdr.

## 1. What Shepherdr actually does

### A. It owns project tasks, rather than mirroring an agent's checklist

`mods/tasks/main.js:1-16,38,68-75` describes one task list per folder, read by the panel and changed through the bundled CLI. A task represents a piece of project work with its own brief, worker and lifecycle. The command lives inside the installed mod at `mods/tasks/bin/herdr-task`.

Ranch's task rows represent steps inside an existing Claude, Codex or OpenCode session. Those are a different level of work. Copying Shepherdr's project-task model directly would change Ranch's meaning and add worktrees, assistants, scheduling and merge decisions the user did not request.

### B. It combines durable records with live Herdr status

The panel reads task-list files, then derives their display state using live worker/helper status. `core/tasks.js:136-181` keeps an agent's question urgent, distinguishes work from readiness, and does not declare readiness while its worker/helper is still busy. Loading an unavailable machine is not treated as proof that its agents have finished.

Ranch should borrow the principle-one shared interpretation of ownership and state-not the entire list of `Queued`, `Scheduled`, `Merging` and `Ready` states. Checklist completion is not the same as reviewed or accepted project work.

### C. Native percentage/message requires no extra task-store reader

`mods/tasks/dot.js:48-54` looks up the worker's exact terminal address and reads its `report.progress` and `report.msg`. `core/tasks.js:229-245` combines those with an optional task report and countdown. Its comments identify the native reporting channel as OSC 7501: a terminal control message carrying agent state/progress.

This is available to Ranch through its installed Herdr API: `C:\Users\LH719EC\.config\herdr-app\herdr.d.ts:216-221` documents `terminals()` as live core terminal records with the agent report in `report`. Native state is also available from `agents()` and panes.

**Do not promise a percentage for every agent.** A read-only check of this audit's OpenCode terminal showed native working state/title, but no percentage in the raw core status record. Availability depends on what the agent reports. Missing progress must remain unknown, not an invented 50% or an inferred completion claim.

### D. Detailed reports are explicit commands in the worker brief

`mods/tasks/bin/herdr_task/launch.py:455-481,502-511` includes the reporting command and exact task identity in the worker's brief. It asks the worker to report its current activity, whole-task percentage and time left through `herdr-task status`.

`mods/tasks/bin/herdr_task/commands.py:597-622` validates that report, verifies the task is running/ready and updates its persisted progress. This avoids depending on the internal name of a provider's plan tool. It still depends on the worker following the reporting contract.

### E. Workers have explicit identity

`mods/tasks/bin/herdr_task/launch.py:682-716` labels workers with a task key, task space and agent; reviewers have a distinct role. The core task key combines the folder's list identity and task ID. The UI matches exact addresses rather than guessing ownership from the focused tab or a coincidental current directory.

For Ranch, preserve **machine + main-session ID + terminal-instance identity**, plus explicit parent/child relationships. Do not replace session identity with folder identity: several independent conversations can share one checkout.

### F. Reads are coalesced and last-good remote data survives

`mods/tasks/main.js:84-89,141-197` holds separate data per machine, allows one read per machine and records a request to read again when another change arrives during a read. It retains remote lists during an outage and removes a machine's entries when that machine is removed. Its local watcher uses one pending watch with bounded waits so a retired mod can encounter its cancellation context.

These are useful patterns for Ranch's stale workspace requests and watcher accumulation. They are not proof that Shepherdr is globally resource-bounded: this comparison is not a whole-repository Shepherdr audit.

### G. Setup is bundled, not absent

`docs/install.md:37-58,119-124` documents installation of mods, helpers, role instructions, hash records and remote synchronization. It also documents optional Claude/Codex **SessionStart and PermissionRequest hooks** for question cards; `--no-hooks` leaves them out. Those hooks are not adapters that capture every TodoWrite/update-plan checklist.

There is no separate task installation screen in the ordinary workflow because the task helper is delivered with the layout. Other machines still need dependencies, and helper files are copied there. "Nothing to install by hand" on those machines does not mean "nothing is installed."

The README lists macOS/Linux support. Python `fcntl.flock`, POSIX shell commands and its launch infrastructure are not drop-in Windows code for this Ranch installation.

## 2. Comparison at a glance

| Concern | Ranch today | Shepherdr pattern | What to borrow |
|---|---|---|---|
| Unit of work | Steps in an existing agent session | Project task with its own worker/brief | Keep Ranch's checklist meaning |
| Detailed data | Provider hook/plugin events | Explicit bundled CLI/task records | A stable reporting contract delivered with Ranch |
| Native live data | Already used for some activity/status | Exact worker status and terminal progress | Add native progress/message as a setup-free baseline |
| Installation | Layout plus separate reporting setup/repair | One layout package includes task infrastructure | One user-facing installation/update lifecycle |
| Identity | Session pointer plus terminal identity; known races | Explicit task/role labels and worker addresses | Exact main-session/terminal ownership, never focus guessing |
| Reads | Several independent readers, uneven race guards | Coalesced machine reads, last-good data | Latest-request ownership and one watch per active root |
| Persistence | Two near-duplicate writers, terminal locks | CLI-owned list store, lock on that list | Lock the document being written; centralize writer behavior |
| Cleanup | Audit found destructive ownership checks | Installed hash/backup preservation policy | Preserve changed user files and task history |
| Platforms | Windows and remote support intended | macOS/Linux/POSIX implementation | Keep Ranch's Node/Windows implementation |

## 3. Recommended Ranch design

### Keep one panel, with two honest sources of information

1. **Native activity:** selected agent, working/blocked/done/idle state, current message and reported percentage when present. This works without Ranch-specific task setup whenever the CLI already reports to Herdr.
2. **Detailed steps:** the existing session checklist when a compatible producer supplies it. Preserve historical session-backed lists and their existing visibility/identity checks.

Use the current task model/shared library rather than introducing a second task framework. Native state must not overwrite checklist history; a checklist's final checked box must not override a currently blocked/working agent. Make the source and freshness clear when necessary.

When steps are absent, say **"No detailed steps reported for this session"**, while still showing native activity. Do not show a misleading empty completed plan, repeated warning badge, or an Install/Setup button as the main task content.

### Remove the separate user-facing task installation

- Include the reporting runtime, supported adapters/plugin and any launch instructions in the **ordinary Ranch package**.
- Install/update their owned files in the same transaction/manifest as the layout, with backups and precise ownership checks. A separate task-only installer should no longer be a prerequisite users must discover.
- Remove Tasks-panel Setup actions and separate Settings task-setup workflows only after the bundled path is verified. Keep a compact diagnostic when reporting genuinely fails; hiding failures is not the goal.
- Do not silently edit global provider permissions, trust arbitrary hooks, expand sandbox access or overwrite instruction files. The normal layout installation must disclose any integration it needs and respect the user's decision.
- Prefer launch-scoped reporting/instructions for Ranch-created agents where the provider supports it. Shepherdr demonstrates that approach for its managed workers. Provider-specific support for Ranch's current Claude/Codex/OpenCode launch paths must be verified before choosing flags or promising identical behavior.
- Already-running and externally started agents must remain usable. Native activity can appear immediately; full checklist capture cannot be promised retroactively without an existing producer or an additional log-reading integration.

**The practical target is "no separate task setup," not "secretly run the current setup button automatically."** Automatic execution of the current installer would propagate the destructive cleanup and misleading health problems found in the audit.

### Keep detailed reporting provider-independent where practical

The supplied Codex command-reporting plan is compatible with this direction: a bundled command accepts a validated list and updates the shared store, instead of relying only on `update_plan`, which current Codex no longer exposes in the documented case.

Retain supported legacy provider events for compatibility. Route all producers through the same validated store semantics. Do not create another writer with its own session adoption/locking rules, and do not let a nested/headless worker inherit authority over the main terminal pointer.

Avoid making every step require a new permission prompt. Equally, do not copy Shepherdr's worker-command allow-list, hook trust hashes or escalation rules wholesale: this request does not authorize changing the user's security policy.

## 4. The choice that still needs an explicit decision

| Option | Separate task setup | Detailed checklist | Trade-off |
|---|---|---|---|
| **A. Bundle reporting with Ranch; native fallback - recommended** | Removed as a separate workflow | Preserved for supported producers | One layout install may still need disclosed provider integration |
| B. Native Herdr data only | None for task reporting | Not available through the inspected native status/progress contract | Smallest solution, but loses the current detailed-step feature |
| C. Parse provider logs instead of hooks/plugins | Can avoid provider configuration writes | Possible after substantial integration work | New session discovery/parsers, remote paths and provider-version fragility; not the smallest complete solution |

**Recommendation: A**, because the request concerns improving the existing task mod, not deleting its checklists. If "no setup" means **no provider hooks/plugins/configuration changes at all**, choose B and explicitly accept summary-only task activity. This distinction cannot be safely assumed away.

## 5. Safe implementation order, for a later approved change

1. Fix audit findings **2-6**: resume data loss, session locks/identity, cross-session leakage, unreadable/future store handling and destructive cleanup. Bundling a broken writer/installer makes those defects more widespread.
2. Add the native status/message/progress baseline without changing checklist storage or user configuration. Reuse one status rule across Session, Sidebar, Topbar and close confirmations.
3. Decide A or B above. For A, move reporting delivery into Ranch's normal package and verify provider-specific launch/config behavior and Windows support.
4. Make the bundled reporting contract work for modern Codex; retain older compatible producers. Resolve the sticky missed-turn warning and main/child session authority at the shared boundary.
5. Remove separate Setup UI only after the replacement path is verified. Keep diagnostics truthful, scoped by machine/provider and based on the actual installed files, not just the presence of one hook.
6. Preserve old task stores/pointers during transition. Do not uninstall the old runtime, remove customized files, rewrite history or clean registries without a separately approved migration and rollback path.

The Git Changes workspace-sync defect remains audit finding **1**. A task redesign does not repair it; track that fix independently.

## 6. Acceptance checks for the proposed change

- A fresh ordinary Ranch install has no task-specific installation step or Setup button. Changes to provider configuration are disclosed, minimal and safely reversible; native-only refusal still leaves a useful panel.
- Native activity appears for an existing agent without launching another agent, sending it a message or changing its session. Missing percentage stays unknown; 0% remains 0%; invalid/non-finite values are rejected or safely clamped.
- Machine-qualified terminal addresses, reused terminal IDs, split panes and parent/child sessions never borrow another agent's progress or checklist.
- Claude, current Codex and OpenCode all have real contract tests, not only synthetic legacy-plan fixtures. External/already-running agents show a truthful fallback rather than a fake full checklist.
- Resuming the same session in a new terminal preserves tasks; binding a different session never inherits them. Two terminals writing one session preserve both updates under the session lock.
- Watch failures, offline/reconnected machines and changes arriving during a read preserve last-good **owned** data and trigger the newest pending read. Retired watches/readers stop without accumulating.
- Closing an agent tab uses the same effective activity state shown by the panel. Uninstall/update preserves changed instructions/plugins and never deletes task history by default.
- Windows paths, spaces, remote Windows homes, Codex sandbox denial and hook/plugin rejection have explicit failure tests. No test depends on the real user home/instruction file.

## 7. Evidence and limits

Inspected the pinned README, install/development docs, task-panel loading/identity/progress paths, shared task state model, terminal progress helper, task-list parser, CLI status writer, launch brief/labels and store locking. Relevant source links:

- [Tasks panel](https://github.com/eliasstravik/shepherdr/blob/ef3be074dd3e28942149b7a5183ab2e2d4207954/mods/tasks/main.js)
- [Shared task state and reporting](https://github.com/eliasstravik/shepherdr/blob/ef3be074dd3e28942149b7a5183ab2e2d4207954/core/tasks.js)
- [Native terminal progress](https://github.com/eliasstravik/shepherdr/blob/ef3be074dd3e28942149b7a5183ab2e2d4207954/mods/tasks/dot.js)
- [Worker launch, brief and identity](https://github.com/eliasstravik/shepherdr/blob/ef3be074dd3e28942149b7a5183ab2e2d4207954/mods/tasks/bin/herdr_task/launch.py)
- [Explicit status command](https://github.com/eliasstravik/shepherdr/blob/ef3be074dd3e28942149b7a5183ab2e2d4207954/mods/tasks/bin/herdr_task/commands.py)
- [Task-store locking](https://github.com/eliasstravik/shepherdr/blob/ef3be074dd3e28942149b7a5183ab2e2d4207954/mods/tasks/bin/herdr_task/store.py)
- [Installation and remote delivery](https://github.com/eliasstravik/shepherdr/blob/ef3be074dd3e28942149b7a5183ab2e2d4207954/docs/install.md)

Shepherdr was **not installed, launched or end-to-end tested**. Its source was fetched for inspection; this is a focused design comparison, not a second complete product audit or a claim that its implementation is bug-free. Native progress support was confirmed in its source and the installed Herdr API, not demonstrated for every current agent CLI. No full-checklist native API was established by this inspection.

**Verdict:** Keep Ranch small: native activity immediately, detailed checklists through one safely bundled reporting path, and no separate Tasks setup workflow. Resolve the audited data-integrity defects before bundling or removing the old integration.
