# Fix set 4 (integrity audit): result

**Branch / worktree:** `fix/1211-integrity` in `~/Projects/ranch-worktrees/4-integrity`, based on `bd639c6`. Nothing is committed (HEAD is still `bd639c6`).
**Date:** 12 November 2026, macOS.
**Scope:** audit findings 1-6, 11, 12, 16, 17, 19, and the non-Codex part of 20. I followed the audit's order: data safety (2-6) first, then workspace ownership (1, 11), then settings and verification (12, 19, 20), then 16-17.

## Verification

| | Baseline (before any change) | After |
|---|---|---|
| `npm test` | 272 tests, 272 pass, 0 fail | **358 tests, 358 pass, 0 fail, 0 skipped** |
| `npm run check` | 9/9 mods `check passed` | **9/9 mods `check passed`** |

No tests failed before these changes, and none fail after them. On this Mac the audit's 9 Windows failures never showed up. They are fixed by construction (see finding 20); I couldn't run them on Windows.

Every test runs against a temp `RANCH_HOME`/`HOME` (and `USERPROFILE` where needed). Nothing ran against the live `~/.herdr/ranch`, `~/.claude`, `~/.codex`, `~/.config/opencode` or the installed mods. No `npm run reload`, `link-dev.sh`, `ranch-tasks install|uninstall|gc`, GC or migration ran on live data.

How the work was done: 1 explorer and 8 implementor workers ran as Herdr sub-agents. I reviewed every diff myself against the code and re-ran the tests. During review I fixed 5 problems the workers had left in; they are listed in each finding below and marked "(review fix)".

## What changed, by finding

### 2, 3, 4, 5: task-store data safety
**Claude/Codex writer: `adapters/store.js`**
- `loadForWrite` (`store.js:114`) is a new writer-side loader:
  - a missing file starts an empty store;
  - an unreadable file, or one with a newer schema, **throws, and nothing is written**;
  - invalid JSON is quarantined to `<file>.error` and logged;
  - another agent's store reads as empty, and its file is left alone.
- The exported `readStore` is unchanged, because an existing test asserts its behaviour.
- `updateStore` now runs through `writeOnce` (`store.js:312`).
  - **Lock order:** the terminal pointer lock first, then at most one session lock: the lock on the session file actually being written.
  - The store is read inside that lock, and `seq` is incremented from the locked value. This fixes finding 3: two terminals sharing a session now take turns writing instead of overwriting each other.
  - **Binding to a different session** (resume of another id, `/clear`, startup, or an id change without SessionStart) takes the target session's lock. If that session exists, its store is loaded. Otherwise the session starts from a complete empty store: tasks, subagents, PRs, `missed_turns` and `session.turn` are all reset (finding 4). Resuming the same session in a new terminal keeps its data.
- `store.js:392` (review fix): the pointer keeps **this terminal's own** `terminal_started_at`. Before, the writer copied in whichever terminal last wrote the shared session file, which hid this terminal's list.
- `recordSharedPr` (`store.js:235`), the shared PR registry:
  - a missing registry starts empty;
  - an unreadable one throws;
  - invalid JSON or a non-object is quarantined, then the registry starts empty;
  - a registry with a newer `version` throws, with nothing written.

**Readers: `lib/tasks.js:274` `withPointerIdentity`**
- The new helper lays the pointer's terminal identity over the session store. It is used in `mods/ranch-session/main.js` `readStoreText` (the import line and one line inside the function only) and in `mods/ranch-sidebar/namer.js` `loadStore`.
- Result: two terminals sharing one session no longer hide each other's task list.

**OpenCode writer: `adapters/opencode-plugin.js`** (still one self-contained file)
- `loadForWrite` (`:200`) follows the same rules as the store.js loader. `normalizeStore` and `emptyStore` now keep `prs`.
- `recordEvent` (`:669`) and `recordUnderTerminalLock` (`:535`) use the same lock order as store.js.
- Finding 2: resuming a saved session in a new terminal now **loads** `sessions/<id>.json`, keeping its tasks, subagents, PRs and seq. Before, it overwrote that file.
- Child (`parentID`) events never bind the main session. A new main session starts completely empty.
- The rule for switching sessions (`:579`) keeps the reducer's existing guards, so a sub-agent's or unrelated event can't take over the pointer.
- Review fixes:
  - the pointer keeps its own start time (same issue as in store.js);
  - a session file is now only ever written while its lock is held (legacy adoption, or an event that names two sessions).
- `logError` (`:166`) writes errors to `~/.herdr/ranch/logs/adapter.log` (rotated at 1 MB, never to stdout). Before, failures were swallowed silently. This also covers the OpenCode part of finding 20.

**Garbage collection: `adapters/install.js:1202` `gcStores`**
- A live terminal's pointer is never deleted because of its age.
- If `hc` is unavailable, liveness is unknown, so no pointer is deleted (temp-file leftovers are still cleaned up).
- A session file is pruned only when it is older than 14 days **and** no surviving pointer refers to it.
- Gone or finished terminals keep the 2-minute rule.
- `listTerminals` can be injected, for tests.

### 6: installer cleanup
All in `adapters/install.js`.
- **Ownership records.** `install.json` now has an `owned` map: `{path: {sha256 of the bytes Ranch wrote, backup}}` (`recordOwned` `:219`).
- **`RANCH.md`** (`installInstructions` `:709`, `uninstallWholeFile` `:742`):
  - Install backs up a pre-existing file that isn't Ranch's before replacing it.
  - Uninstall restores that backup byte-for-byte only if the current file is still exactly Ranch's bytes; with no backup, it deletes Ranch's copy.
  - If the person edited the file, uninstall leaves it alone and reports "changed since install, left as is".
  - Legacy installs with no ownership record are handled by comparing the file to the exact rules text.
- **OpenCode plugin** (`installOpencode` `:642`, uninstall):
  - If the plugin is exactly Ranch's bytes, uninstall restores the recorded original or deletes the plugin.
  - If it is a Ranch plugin the person edited, or one from an older Ranch version, it is backed up before it is deleted, and the backup path is reported.
  - A file that isn't Ranch's is not touched.
- **Hooks** (`withoutRanchHooks` `:102`): only Ranch's individual hooks are removed. A group is dropped only when it ends up empty, so a mixed group keeps the person's own hooks. This applies to both install and uninstall.
- **CRLF**: `adapters/instructions.js:47,55` `stripBlock`/`withBlock` keep the file's own line endings, so a CRLF `CLAUDE.md` or `AGENTS.md` round-trips byte-for-byte.

### 1: Changes pane shows the previous workspace
- `mods/ranch-changes/main.js:65` `refresh()` now checks the context *before* the busy/loading guard and wipes the old context's files, diff, root, message and errors.
- A new `requestGate` in `mods/ranch-changes/model.js` gives each read a token. Only the latest read's result is applied, and an old completion can't clear a newer read's loading state. When an old read finishes, a queued newer context starts at once instead of waiting for the 10 s timer.
- Review fix: the pane also re-reads at once when focus moved but no render queued the new context, so it can't sit in "loading" for 10 s.
- The commit-time context guard is unchanged.
- **Your decision:** the pane keeps following the focused shell's repo. The header now shows the repo name, plus the machine for remote repos (`main.js:113`).

### 11: requested worktree silently becomes a normal launch
- `mods/ranch-launch/main.js:107` `probeRepo` tracks the repo check explicitly (`pending | repo | none | error`) with a generation token. The pure `launchDecision` (`lib/launch.js:60`) decides what Enter does (`main.js:178`).
- **Your decision:**
  - While the repo check is running, Enter doesn't launch and the dialog shows "Checking repository…".
  - If there is no repo, the check fails, or the home folder can't be found, the dialog shows an error and nothing launches.
  - A plain launch happens only when worktree mode is off.
- Closing the dialog doesn't delete anything (checked).

### 12: corrupted saved UI state
- **Topbar:** `mods/ranch-topbar/main.js:36` now reads saved state through `readPanels` (`mods/ranch-topbar/state.js`). Invalid JSON, `null`, arrays, strings and unknown panel ids are dropped, and the `localStorage` read itself is guarded.
- **Sidebar:** `normalizeCollapsed` (`mods/ranch-sidebar/model.js:268`, used at `main.js:86`) checks each of `m`, `s`, `w` and `settled` separately and keeps the usable neighbouring values.

### 16: offline lookup permanently disables sidebar Git discovery
- `topOf` entries are now `{top, at}`. `topOfFresh` (`model.js:254`, used at `main.js:934`) keeps positive results and expires negative ones after 30 s, so a location is re-checked at most once per window.
- Deviation: the audit suggested separate expiries for "not a repo" and "lookup failed", but `lib/git.js` returns a plain `null` for both and is owned by tab 3. I used a single 30 s window.

### 17: remote Windows home and remote session usage
- New `lib/home.js` (`probeHome`, `homeCache`) tries `sh` first, falls back to `cmd.exe` (`%USERPROFILE%`), and waits 30 s before retrying a failed lookup. Sidebar (`main.js:61`), namer and Launch use it. Session already had its own fallback and is unchanged.
- **Your decision:** session usage is marked unsupported rather than guessed. `mods/ranch-usage/main.js:160` with `usage/session-support.js` shows "Session usage: not available for remote terminals" for a remote terminal. For Codex on Windows it shows "not available on Windows" instead of running `pgrep`/`lsof`. Provider account limits are unchanged.

### 19: diff setting also hides PR badges
- PR fetching and PR badges now depend on `card.pr` alone (`main.js:944` and the shared-registry enqueue). `card.line3` controls only the diff statistics.
- The four on/off combinations are decided in one place by `cardRows` (`model.js:287`, used at `main.js:537,723`) for ordinary cards and worktree rows.
- Grouped and settled cards show neither, as before; that's a layout rule, not a setting.

### 20: diagnostics and tests (non-Codex part)
- **Drift detection:** it now compares every file the installer copies (`runtimeFiles` `:46`, `installedRuntimeDiffers` `:64`) plus Ranch's installed OpenCode plugin, not just `cli.js`.
  - Review fix: a person's own non-Ranch file at the plugin path no longer counts as drift.
- **Settings health:** it now refreshes every 30 s and whenever the panel gets focus (`mods/ranch-settings/main.js:53,113,152`). Loads never overlap. The checks that start processes (git and Herdr version) run at most every 5 minutes.
- **Windows test isolation:**
  - `pathToFileURL(...).href` replaces raw-path dynamic imports in the session-model, session-win, sidebar-model and usage tests.
  - Expectations for simulated POSIX output are built with the same `join()` the code uses, or compared after normalizing separators.
  - `USERPROFILE` is now set next to `HOME`.
  - The OpenCode plugin reads its `AGENTS.md` marker from `RANCH_HOME` instead of the real home (`opencode-plugin.js:468`); the test in `test/adapters.test.js` was updated to match.
  - No assertion was weakened or skipped.

## Tests added
All new test files use isolated temp homes. Each was confirmed to fail before its fix (the workers' failing runs, plus my own before/after runs for the review fixes).

| File | Tests | Covers |
|---|---|---|
| `test/store-integrity.test.js` | 16 | different-session resume, `/clear`/startup/id-change full reset (tasks, PRs, missed_turns, turn), same-session resume in a new terminal, compaction, lock held → no write, 8-process two-terminal race (all 8 tasks kept, seq +8), newer/unreadable/invalid stores, PR registry quarantine/refusal, pointer identity |
| `test/opencode-integrity.test.js` | 11 | resume in a new terminal keeps tasks/subagents/PRs/seq, child events, another agent's store, malformed/newer/unreadable files, session switch resets, lock held, `AGENTS.md` isolation, shared-session start time |
| `test/install-safety.test.js` | 12 | custom `RANCH.md` restored, user-edited file left alone, repeated install/uninstall, CRLF, custom/edited plugin, mixed hook group, GC (live, gone, no hc), runtime drift, non-Ranch plugin is not drift |
| `test/ranch-changes-model.test.js` | 10 | A→B while a read is in flight, immediate re-read, commit in progress, folder with no repo, rapid A→B→A, stale completion, header label |
| `test/launch-decision.test.js`, `test/home.test.js` | 5 + 7 | Enter before the repo check finishes, no repo, failed home lookup, worktree off; `sh`→`cmd.exe` fallback, retry wait, shared lookup |
| `test/ranch-sidebar-integrity.test.js`, `test/ranch-topbar-state.test.js` | 15 + 6 | corrupted saved state, `topOf` expiry, the four line3/pr combinations |
| `test/ranch-usage-session.test.js` | 4 | remote terminal / Codex on Windows marked unsupported |

## Differences from the report
- **Finding 6:** the explorer pass claimed `RANCH.md` uninstall leaves the file alone when it equals the rules text. That is wrong. The code (`stripped = ""` for whole-file entries) blanks a custom file and deletes a Ranch-created one even after the person adds to it, exactly as the audit says.
- **Finding 12:** the sidebar already had a try/catch around its saved state. Only the shallow merge was the bug.
- **Finding 20:** none of the 9 Windows failures reproduce on macOS (the baseline here was 272/272).
- **Finding 3, child agents:** your decision was to defer this. Not implemented; see Open issues.
- **Finding 16:** single 30 s window instead of separate "not a repo" and "lookup failed" expiries (`lib/git.js` can't tell them apart and belongs to tab 3).
- Line numbers in the audit matched `bd639c6`, give or take a few lines.

## Proposals for you (not done)
1. **Live data:** after this lands, `ranch-tasks gc` is safe to run. Look first for existing `~/.herdr/ranch/tasks/sessions/*.json.error` and `prs.json.error` files: these new quarantine files only appear once the new code meets a bad file. Nothing was cleaned up automatically.
2. **Existing installs with no ownership record:** if the old installer overwrote a custom `RANCH.md` or plugin, the original may still be in `~/.herdr/ranch/backups/` (`instructions-.claude-RANCH.md.*`, `opencode-plugin.*`). Uninstall doesn't search for those unnamed backups; restoring one is a manual step.
3. **Product decisions from the audit's "Additional safety/design notes"** (listed only, not changed):
   - The Changes pane always runs `git add -A` (it commits everything, even past the 1,000-file display cap). The audit suggests labelling it "Commit all changes" and warning when the list is truncated.
   - Child task reads should get the same ownership checks as the Git/PR reads.
   - Per-space panel names and some sidebar/naming maps keep entries for closed spaces (pruning belongs with finding 14).
   - Narrow-window, high-DPI and keyboard-scroll layouts haven't been checked.
   - Windows URL opening and child-process lifetime deserve explicit tests.
   - Some docs are stale: the mod count, the store schema docs and the Codex tool descriptions.

## Cross-tab requests
- **Tab 1 (bugs):** `adapters/store.js` `updateStore` was restructured (it now goes through `writeOnce`), and the same happened to the OpenCode plugin's `recordEvent`. `missed_turns` increment and reset logic in `claude.js`, `codex.js` and `reduceOpencode` was **not** touched. A genuinely new session now starts from `emptyStore` (`missed_turns: 0`) at the store level. Please rebase onto this.
- **Tab 2 (Codex):** the Codex trust/approval parts of finding 20 (doctor's approval status as healthy/unhealthy/not verified, nested trust parsing) are yours. `statusSummary` now uses `installedRuntimeDiffers`; rebase any changes to it. Child-agent rebinding (deferred here) could share a guard with your terminal-type work.
- **Tab 3 (caching):**
  - Finding 16 would be cleaner if `lib/git.js` `repoSummary` returned a distinct "not a repo" result (Git exit 128) versus a timeout or unreachable machine; the sidebar could then use separate expiries.
  - `mods/ranch-sidebar/main.js` `topOf` values are now `{top, at}` objects. Keep that shape if you add pruning.
  - `readStoreText` in `ranch-session/main.js` changed by one line.
- **Tab 5 (design):** the sidebar's close confirmation wasn't touched. `cardRows` and `topOfFresh` are new in `mods/ranch-sidebar/model.js`.

## Open issues
- **Child/headless agents can still rebind a terminal's pointer** (deferred by your decision). Options: Ranch-launched agents could export a marker such as `RANCH_MAIN`, or this could share a guard with tab 2's Codex work.
- **Legacy-flat edge case:** a terminal with no pointer that adopts a legacy flat store for session X writes `sessions/X.json` from the legacy content, even if X already exists from another terminal. This only affects schema-1 leftovers and matches the old behaviour.
- **Sidebar namer:** it no longer logs failed remote-home lookups, because `lib/home.js` handles those errors itself.
- **Changes pane label:** it appears only after the first successful read of a new context.
- **Real concurrency** was tested with child processes on one machine, not against live Herdr hooks. Windows was not run here.
