# Fix set 2 (Codex task reporting): result

Worktree `~/Projects/ranch-worktrees/2-codex`, branch `fix/1211-codex`, HEAD still `bd639c6`. Nothing committed (not requested).

## Decisions taken with the person

1. **A vs B (report 5 §4):** the person chose **A** (bundled reporting command).
2. **After new evidence (below):** the person chose **both routes**: the `ranch-tasks plan` command *and* documenting/detecting Codex's own `update_plan` toggle. Instructions now say "use update_plan if you have it, otherwise run the command".

## Verified facts that differ from the report

Codex is not installed on this Mac, so Step 0 (live payload capture) was not possible. Instead I read Codex's source at tag **`rust-v0.167.1`** (and main `d0edb0b`, 2026-11-12) via `gh api`:

| Report claim | Codex source says | Effect |
|---|---|---|
| "0.167.1 no longer exposes `update_plan`; no flag brings it back" | `update_plan` is registered only when `config.update_plan_enabled` (`core/src/tools/spec_plan.rs:1301`). Config schema: `[tools.update_plan] enabled` (default **false**). When enabled it emits PostToolUse with `tool_name: "update_plan"` and the parsed `{plan}` args (`core/src/tools/registry.rs` default `post_tool_use_payload`) | Setting `[tools.update_plan] enabled = true` in `~/.codex/config.toml` restores Ranch's existing path with zero code. Not verified live. |
| PR detection broken: Codex uses `exec_command` with `tool_input.cmd` | exec_command's hook payload uses `HookToolName::bash()` → `tool_name: "Bash"`, `tool_input: {"command": "<string>"}` (`core/src/tools/handlers/unified_exec.rs:144`, `core/src/tools/context.rs:476`) | The existing matcher `update_plan\|Bash\|shell` and `detectCreatedPr` already handle it. **Secondary issue 1 is not a bug.** Added a regression fixture instead of speculative `cmd` code. |
| Add `exec_command` to the matcher | Codex never sends that name. Changing the matcher changes each hook's trust hash (`hooks/src/engine/discovery.rs` `hook_hash`) | **Not done.** It would force every user to re-approve the hooks for no gain. |
| New trust format `["hooks"."state".'…hooks.json:session_start:1:0']` with `trusted_hash` | Confirmed: key = `<hooks.json path>:<event>:<group>:<handler>` (`hooks/src/lib.rs:125`), value `{enabled?, trusted_hash?, trusted_content_hash?}` (`config/src/hook_config.rs`). Hook runs only if `enabled != false` and `trusted_hash == sha256 of the TOML-serialised hook definition` | Implemented parsing. Ranch **cannot recompute the hash** (exact toml_edit serialisation), so a changed hash is not detectable; documented. |
| Report §4.3: only `lib/prs.js` change needed for PR detection | `adapters/codex.js:107` also gates on `tool_name` | Moot, since the name is `Bash`. |
| Report §4.3 installer: nothing about libs | Install copies only `lib/tasks.js` and `lib/prs.js` | Added `lib/tasks-command.js` to the copy list, else the installed hook would crash on import. |

Line numbers in the report matched `bd639c6` (`install.js:24`, `codex.js:108`, `install.js ~930`).

## What changed

- **`adapters/plan.js` (new):** `parsePlanArgs` (`:25`): `todo|doing|done|skip` and the long status names, case-insensitive, split on the first colon only, whitespace and newlines collapsed. Errors: no args, no colon, unknown prefix, empty title, title over 500 chars, more than 50 tasks. `planSummary` (`:55`) prints e.g. `ranch: 3 tasks (1 doing, 1 done, 1 todo)`.
- **`adapters/cli.js`:**
  - `runPlan` (`:88`) and the `plan` command (`:203`). It requires `HC_TERMINAL_ID`. Guard 1 reads the terminal pointer and needs agent `codex`. It then writes **only through `updateStore` + `applyCodex`** (a synthetic `update_plan` event). Guard 2 runs inside the writer's callback and refuses unless the store is a Codex store with a session id. No own locking, adoption or pointer writes. A write failure prints the sandbox hint.
  - The reminder gets the home dir (`:70`).
  - The human doctor output shows `??` for unverified checks (`:238`).
- **`adapters/instructions.js`:**
  - `planCommandLine(home)` (`:20`) gives the absolute per-OS command. Windows: `node "C:/…/ranch-tasks.js" plan`, with backslashes normalised.
  - `rulesFor`/`blockFor`/`reminderFor` take an optional `home` (`:29`, `:54`, `:84`). The Codex wording is "update_plan if you have it; otherwise run `<abs cmd> "doing: …" "todo: …"`". Claude and OpenCode text is byte-identical, pinned by tests.
- **`adapters/install.js`:**
  - `lib/tasks-command.js` copied into the runtime (`:458`).
  - The Codex AGENTS.md block gets the home dir (`:623`).
  - `codexNestedTrust` (`:1007`) parses all three spellings: header tables, inline tables and dotted keys.
  - `codexTrustState(doc, text, hooksPath)` (`:1108`) matches the hooks.json path, Windows-safe (slashes and case). Outcomes:
    - nested entry with `enabled=false` or no `trusted_hash`: "needs approval";
    - any trust info present but a Ranch position missing: "needs approval";
    - no trust info at all: `null` (unknown, as before).
  - `pruneCodexTrustText` (`:1185`) now never deletes non-legacy keys. Before, an inline nested entry under `[hooks.state]` would have been **deleted as stale on install**.
  - `codexUpdatePlanEnabled` (`:1198`).
  - `statusSummary` passes the hooks path.
- **`adapters/doctor.js`:**
  - The "codex hook approval" check (`codexChecks`, `:121`) is now real. Trusted passes, with a "hash not re-checked" note. "Needs approval" fails. Unknown passes with `unknown: true`. Before, it always passed.
  - New informational check "codex update_plan tool".
  - New synthetic check "codex plan command" (`:181`, `planCheck` `:104`) runs the real CLI in the temp home.
  - Shared `readSyntheticStore` helper (`:44`).
- **`RECIPE.md`:**
  - Fixed the stale Codex matcher text and listed `plan` among the subcommands.
  - Described both Codex routes.
  - Sandbox `writable_roots` note (Ranch does not edit sandbox settings).
  - Nested trust format and the hash limitation.
  - Installed lib list.

`lib/` is untouched, so the mod copies are unchanged.

## Tests added (272 → 322, all pass)

- `test/plan.test.js` (10 tests):
  - parsing and errors; summary;
  - end-to-end write after a Codex SessionStart;
  - plan then Stop does not increment `missed_turns`, with a **control** showing a turn without `plan` is counted;
  - byte-identical no-write refusals: no `HC_TERMINAL_ID`, bad prefix, Claude terminal, no pointer;
  - the legacy `update_plan` hook still works.
- `test/instructions.test.js` (16): command forms for POSIX, spaces, Windows drive and UNC; Codex rules and reminders; Claude/OpenCode pinned.
- `test/codex-trust.test.js` (18):
  - nested header/inline/dotted spellings;
  - missing, `enabled=false` and no-hash cases;
  - Windows literal key with case difference; foreign hooks.json path;
  - legacy still works; unknown;
  - prune never deletes nested entries; prunes only stale legacy keys;
  - `codexUpdatePlanEnabled` spellings, profile-only, empty;
  - install copies `tasks-command.js`.
- `test/doctor.test.js` (+4): plan check passes end to end; nested partial trust fails; no config gives `unknown`; toggle detected.
- `test/fixtures/codex-exec-command.json` + `test/prs.test.js` / `test/scenarios.test.js`: the source-derived exec_command payload (`Bash` + string `command`) records the PR. **Fixture is from Codex source, not a live capture.**

Audit finding 7 regression list:
- Covered: exec_command payload (source-derived), old update_plan, multiline arguments, rejected/malformed plan, approved and unapproved nested trust.
- **Changed-hash nested trust is not detectable** (documented).
- Writable-root failure: only the error message path exists. It was not exercised under a real Codex sandbox.

## Verification

```
baseline (bd639c6): npm test 272/272 pass; npm run check: 9/9 mods pass
final:              npm test 322/322 pass (0 fail); npm run check: 9/9 mods "check passed"
manual: temp RANCH_HOME, codex SessionStart then `bin/ranch-tasks plan "done: Read" "doing: Write\nmulti line" "todo: Test"`
        -> "ranch: 3 tasks (1 doing, 1 done, 1 todo)", exit 0; store tasks 1/2/3 completed/in_progress/pending,
           title "Write multi line"; `plan "nope: x"` -> exit 1 with prefix error.
```

No pre-existing failures on macOS (the audit's 9 failures were Windows-only).

## How the work was done

Four opencode implementor workers (GLM-5.3-Flash, no fallbacks needed), started as Herdr sub-agents. I reviewed every diff. Fixes I made myself during review:
- Windows backslash normalisation in `planCommandLine`; the worker had loosened its test to accept mixed slashes.
- The missed-turn test control.
- A JSDoc comment glued onto `function pruneCodexTrust` (lost newline).
- Moved the explanation out of the code span in the Codex rule.
- Rendering of `unknown` in human doctor output.

## Proposals for the person (not applied)

1. **Simplest fix for your Codex tabs today:** add this to `~/.codex/config.toml`:
   ```toml
   [tools.update_plan]
   enabled = true
   ```
   Then start a new Codex tab. If tasks appear, the native route works and needs no reinstall. I could not test this (Codex isn't installed on this Mac).
2. After merge, reinstall (`ranch-tasks install --yes`) so `~/.codex/AGENTS.md` gets the new wording and the runtime gets `plan.js` + `lib/tasks-command.js`. The hook matcher is unchanged, so **no Codex re-approval should be needed**.
3. If you run Codex with `sandbox_mode = "workspace-write"` and use the command route, add `~/.herdr/ranch` to `[sandbox_workspace_write] writable_roots` yourself. Otherwise use proposal 1, where hooks write the store instead of the command.
4. Optional: capture one real PostToolUse payload (temporary hook writing stdin to a file) to replace the source-derived fixture.

## Cross-tab requests

- **Tab 4 (integrity):**
  - Shared-session locking, resume preservation and **child identity binding** must land before rollout. `plan` goes only through `updateStore`/`applyCodex`, so it inherits those fixes.
  - The guard checks only "this terminal is a Codex session". A nested `codex exec` started in the same terminal (inherits `HC_TERMINAL_ID`) could still run `plan` or rebind the pointer. That is report secondary issue 3, deferred to your shared-boundary fix.
  - Finding 20: Settings could show doctor's new `unknown` flag and "needs approval" for nested trust; `statusSummary` already returns "needs approval" for nested-format gaps.
- **Tab 1 (bugs):** I did **not** change `lib/prs.js`. Codex sends `Bash` + `command` string, so no `tool_input.cmd` support is needed for Codex. If audit 8's "`cmd`" item adds it, there's no conflict with this branch.
- **Tab 5 (design):** the `[tools.update_plan]` toggle is a config-only route for Codex checklists. It fits "bundle reporting" without a custom command, but depends on a default-off Codex setting. Both routes are now documented.
- **Merge overlap:** this branch edits `adapters/{cli,instructions,install,doctor}.js`; per README order it rebases after tabs 4, 1 and 3.

## Open issues

- Nothing verified against a live Codex: the payload shape, the toggle, and whether hooks or exec commands run sandboxed all come from source reading.
- Changed `trusted_hash` (hook modified after approval) cannot be detected by Ranch; doctor says so.
- Report secondary issue 3 (`codex exec` taking over a terminal) is deferred to tab 4 as above.
- An installed runtime older than this change will fail doctor's "codex plan command" check until reinstalled. That's expected.
- RECIPE's Claude matcher text (`TodoWrite|TaskCreate|TaskUpdate`, the code has `|Bash`) is also stale. It's outside my scope and was left alone.
