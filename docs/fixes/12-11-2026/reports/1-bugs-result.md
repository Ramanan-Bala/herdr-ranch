# Fix set 1 (bugs): result

Tab: `fix 1: bugs`. Worktree `~/Projects/ranch-worktrees/1-bugs`, branch `fix/1211-bugs`, base `bd639c6`.
Nothing committed or pushed. HEAD is still `bd639c6`; all changes are in the working tree.

| Item | Status |
|---|---|
| Bug 1: cross-repo PR filed under the wrong checkout (+ audit 8) | Fixed, with tests |
| Bug 2: tab rename hits the focused tab (+ audit 13, rename part) | No repo-owned text to fix. Proposal below for the person |
| Bug 3: sticky "no task updates" badge (+ audit 13, counter part) | Fixed, with tests |
| `prs.json` cleanup | Proposal only (nothing polluted on this Mac) |

## Verification

| | Baseline (`bd639c6`) | After |
|---|---|---|
| `npm test` | 272 / 272 pass | **297 / 297 pass** (25 new tests) |
| `npm run check` | 9 / 9 mods pass | 9 / 9 mods pass |

No failures remain. None existed on macOS before the work (the audit's 9 failures were on Windows).
TDD check: I copied `bd639c6` into a scratch folder and ran the new tests against the old code. 10 of the 12
original missed-turn tests failed there. The 2 that passed pin behaviour that must not change: a work turn with
an `in_progress` list still counts, and read-only tools don't count. The end-to-end shared-PR test and the new
`prs.test.js` cases also failed there.

## What changed

### Bug 1: shared PR registry ownership (`lib/prs.js`, `adapters/cli.js`, two mods)

Write side: a PR is shared only when its ownership is confirmed. The creating session's own record
(`store.prs` in `claude.js` / `codex.js`) is unchanged, so that session keeps showing the PR.

- `lib/prs.js:97`: `GH_PR_CREATE` now also matches the global flag forms `gh -R o/r pr create`, `gh --repo o/r pr create` and `gh --repo=o/r pr create`.
- `lib/prs.js:103` `prRepoOf(url)`: gets `owner/repo` from a PR URL.
- `lib/prs.js:109` `repoOfWebBase(base)`: gets `owner/repo` from `webHost().base`.
- `lib/prs.js:118` `remoteReposOf(text)`: reads the GitHub repos out of `git remote -v` (https, ssh:// and scp-style URLs).
- `lib/prs.js:128` `prCommandOf(input)`: reads the command from `tool_input.command` or `tool_input.cmd`, as a string or an argv array.
- `lib/prs.js:138` `prCreateHead(cmd)`: reads `--head` / `--head=` / `-H` and strips an `owner:` prefix. It looks only inside the gh segment.
- `lib/prs.js:155` `effectiveDir(cmd, cwd, workdir, platform)`: works out where the command ran.
  - Starts from the tool's `workdir`, or the session cwd.
  - Applies the last `cd <dir>` before the gh segment.
  - On win32, turns Git Bash `/c/...` paths into `C:/...`.
- `lib/prs.js:184` `registryPrBelongs(url, checkoutRepo)`: the read-side guard (rule under "Read side" below).
- `lib/prs.js:194` `samePr(a, b)`: compares PRs by URL, and by number only when a URL is missing.
- `lib/prs.js:209` `detectCreatedPr`: changes to response handling:
  - Also scans `tool_input.cmd`.
  - Returns nothing when the tool exited non-zero.
  - For object responses, scans only `stdout`, where gh prints the created URL. gh's "already exists: <url>" error goes to stderr, so it's no longer recorded.
  - Returns nothing for a string response containing "already exists".
  - Keeps "last URL wins" when there are several.
- `adapters/cli.js:84` `repoFacts`: now returns `{ top, branch|null, remotes }`. A detached HEAD is fine when `--head` names the branch.
- `adapters/cli.js:110` `recordSharedPrFromPayload`: works out the folder the command ran in (`effectiveDir`) and its checkout. The PR is recorded only if one of that checkout's remotes is the PR's repo. The branch comes from `--head`, otherwise from that checkout's HEAD. Otherwise nothing is shared.

Read side: shared records only. The session's own records are never filtered.

- The rule (`registryPrBelongs`): a shared record whose PR repo differs from the checkout's `origin` repo is skipped. It is kept when the repo names match (a fork's PR to upstream) or when the checkout's repo is unknown.
- `mods/ranch-session/main.js:1588`: the registry loop in `recordedPrs` skips such records. The own-store loop above it is unchanged.
- `mods/ranch-session/main.js:1531`: row id `agent-pr-${p.url}` (was `p.number`), so the same PR number in two repos doesn't collide.
- `mods/ranch-sidebar/main.js:254`: `recordedResolved` takes a new `checkoutRepo` argument and skips foreign records.
- `mods/ranch-sidebar/main.js:259`: the duplicate check against the branch PR now uses `samePr`, not number-or-url, so a foreign PR with the same number is no longer hidden.
- Both sidebar call sites pass the repo from `summary.host.base`.

### Bug 3: missed-turn semantics (`adapters/claude.js`, `codex.js`, `opencode-plugin.js`)

Turn semantics, now pinned by tests (`test/missed-turns.test.js`):

- A turn starts at a real user prompt and records the task-list fingerprint.
- At the turn's end, it counts as missed only if it did **work** (a write, edit or shell tool ran) **and** the list is unchanged.
- The turn is then consumed, so a duplicate Stop or idle never counts it again.
- Interrupted or failed turns (OpenCode) are consumed without counting.
- Any task-list change resets `missed_turns` to 0. So does a fresh session.
- There is deliberately no "skip when an `in_progress` task exists" rule, per the audit's Caution. A test pins that such a turn still counts.

Changes by file:

- `adapters/claude.js`
  - Lines 234 and 247: fresh session or session-id change resets `missed_turns` to 0.
  - Line 293: a task change in PostToolUse resets it.
  - Line 307: Stop consumes the turn.
  - `turn.tools` is now set on a copied session rather than by changing the input store.
- `adapters/codex.js`
  - Lines 72 and 85: fresh session resets `missed_turns`.
  - Line 127: an `update_plan` change resets it; any other tool marks the turn as worked.
  - Line 144: Stop counts only when the turn did work, then consumes the turn. Before, every pure Q&A turn counted.
- `adapters/opencode-plugin.js`
  - Line 281: activity "done" judges the turn once and consumes it. The old "busy means work" rule is gone, so pure Q&A runs no longer count.
  - Line 310: `WORK_TOOLS` lists the tools that count as work.
  - Line 339: `todo.updated` resets `missed_turns` when the list changes.
  - Line 369: a new main session resets it.
  - Line 420: new internal `tool.used` event. A work tool marks the turn as worked. It returns the same store when the turn is already marked, so there's no store write per tool call.
  - Line 432: `session.error` (v1 interrupt) marks the turn aborted. `normalizeStore` keeps `turn.aborted`.
  - Lines 607 and 609: `normalizeV2` (now exported) tags `execution.failed` / `execution.interrupted` as `outcome`.
  - Line 679 and the v2 `execute.after` hook: emit `tool.used` for non-todowrite tools.

### Tests added

- `test/missed-turns.test.js` (new, 13 tests): Claude, Codex and OpenCode cases.
  - Miss, then a valid report clears it.
  - Duplicate Stop.
  - An `in_progress` turn still counts.
  - Fresh session / session-id change.
  - Codex pure Q&A.
  - OpenCode no-tool run, a re-idle without a prompt, interrupted or failed run, `session.error`, read-only tool, and repeated work tools leaving the store unchanged.
- `test/prs.test.js` (+11 tests): every new helper, plus detection cases.
  - `/c/...` conversion only on win32, quoted, relative and leading-whitespace `cd`, `workdir`.
  - `--head=me:feat`, and head flags after the gh segment ignored.
  - All three remote URL forms.
  - Fork, foreign and unknown repo for the guard.
  - The same number in two repos.
  - `gh -R`, `cmd`, stdout-only scanning, non-zero exit, "already exists", several URLs.
- `test/shared-prs.test.js` (new, end to end through `bin/ranch-tasks` with temp git repos and a temp `RANCH_HOME`):
  - `cd B && gh pr create --head` from A is filed under `B|fix/x`, with nothing under A.
  - `-R` with no `cd` gives no registry entry, but the terminal's own store keeps the PR.
  - A same-repo PR is filed under `A|dev`.
  - `workdir` = B is filed under B.
  - A failed "already exists" create writes nothing.

## How the work was done

Two Herdr implementor workers on GLM-5.3-Flash ran in parallel with separate files: Bug 3 and Bug 1. I reviewed
both diffs line by line and re-ran the suites myself. Review findings:

1. `prCreateHead` also read `-H`/`--head` from segments after `gh pr create`. In `&& curl -H "Accept: x"`, the header would have become the branch.
2. `effectiveDir` missed a `cd` that had leading whitespace.
3. OpenCode `tool.used` wrote the store on every tool call, even when the turn was already marked.

I fixed all three myself, test-first, because each was 1-2 lines. That departs from the protocol's "send findings to a fixer" step.

## Deviations from the report (code vs report, and choices made)

- **Line numbers** in the report matched `bd639c6`, give or take a few lines. No claim was wrong.
- **Codex never set `turn.tools`** at all (`codex.js` PostToolUse). The report said "no tool-use check"; it is fixed as part of this.
- **OpenCode re-counted continuations.** The old reducer only reset `turn.tools` after a miss, so the next run's "busy" re-armed it. A continuation without a new prompt could count again. The turn is now consumed instead.
- **OpenCode work detection** now uses real tool events (`tool.execute.after`: bash, edit, write, patch, multiedit, apply_patch) instead of "the session went busy". That matches Claude's definition. It adds one v1 hook and widens the v2 `execute.after` handler.
- **The report's "only count when there is no in_progress item" was not applied**, per the audit's Caution.
- **`git -C <dir>` is not used for ownership.** gh ignores it; gh runs in the shell's cwd. `gh -R` alone, with no matching local checkout, means the PR is not shared (report test case 2).
- **Read-side guard checks `origin` only.** The mods only know `origin` (`lib/git.js` `repoSummary`, owned by tab 3). To avoid hiding a fork's PR to upstream, a matching repo name also counts. A foreign repo with the same name as the checkout would still show. That's rare and accepted.
- **Not done (optional in the report):**
  - The `last_missed_at` / `tasks_updated_at` mod-side logic. Stores already stuck with a non-zero count clear on the next task change.
  - Showing the repo name next to a foreign own-store PR. The session panel already shows `#n owner/repo` until the lookup arrives.
  - The sidebar showing a card's own-store PRs.
- **The "complete session reset" add (audit)** is applied to the counter: `missed_turns` and `turn` are cleared on every fresh session or session-id change. Resetting tasks and PRs across sessions is audit finding 4, owned by tab 4.
- **`~` in a `cd` path is not expanded.** The checkout lookup then fails, so nothing is shared. That fails safe: the creator's store still has the PR.

## Proposals for the person (nothing below was applied)

### P1. Tab-rename instruction (Bug 2)

On this Mac, the tab-rename text is in **no** repo file and **no** live instruction file. I checked `adapters/instructions.js`
(it writes only the task-reporting block), `~/.claude/CLAUDE.md`, `~/.claude/RANCH.md`, `~/.config/opencode/AGENTS.md`
and `~/.codex/AGENTS.md`. `~/.config/agent-instructions/` does not exist here. The faulty text lives in the Windows machine's
`~/.config/agent-instructions/AGENTS.md`, section "Herdr Tab Names". Ranch's own tab namer (the sidebar mod) already
renames by tab id, so it is not affected.

I checked the label on this Mac: `hc get "$HC_TERMINAL_ID" --json` returns `labels["herdr.tab"]` for the caller's own tab.

Replacement section for a **macOS/Linux** (zsh/bash, POSIX) instruction file:

```markdown
## Herdr Tab Names

- At the start of every Claude or OpenCode session, once the opening task is clear, rename the tab this
  agent runs in (never the focused tab). Get the tab from your own terminal's labels:

      tab=$(hc get "$HC_TERMINAL_ID" --json 2>/dev/null | sed -n 's/.*"herdr\.tab":"\([^"]*\)".*/\1/p')
      [ -n "$tab" ] && herdr-app do tab.rename --id "$tab" --name "<task title>"

- Do not use `herdr-app status` for this; it reports the user's focused tab.
- If `HC_TERMINAL_ID` is unset or the terminal has no `herdr.tab` label (for example a sub-agent started
  with `hc run`), skip renaming. Sub-agents never rename. Don't create or switch tabs just to rename one.
- On a remote machine, app tab ids are prefixed `<machine>/`; the label is machine-local, so prefix it
  when renaming from another machine.
```

For the **Windows** file, keep the report's PowerShell snippet. Its logic is the same.

Separately, `scripts/link-dev.sh:23` (repo-owned, a dev-only script) also reads the focused tab from `herdr-app status`. It reloads
the user's current tab on purpose, so I left it alone.

### P2. `prs.json` cleanup

On this Mac, a read-only scan of `~/.herdr/ranch/prs.json` found 3 keys and **no** foreign entries, so nothing needs doing here.
On the Windows machine, as the report says: move `https://github.com/ey-fso-tax/forms-profile-api/pull/1299` from key
`C:/Raptor/raptor-forms-render|dev/Anand/blockmerge-sbx` to `C:/Raptor/raptor-forms-profile-api|fix/FG-7997-studio-expr-prefix`,
with the Herdr mods idle. The render session's own store keeps its copy, so creator history is preserved. Even without the
cleanup, the new read-side guard hides that entry in render tabs once this branch is installed.

## Cross-tab requests

- **Tab 3 (caching, owns ranch-session Git/PR code and `lib/git.js`):**
  - I edited `mods/ranch-session/main.js` `recordedPrs` (registry loop, ~L1581-1592) and the agent-PR row id (L1531). Please rebase onto these lines rather than rewriting them.
  - If the summary ever exposes all remotes rather than just `origin`'s host, `registryPrBelongs` should take that list. The same-name fork fallback could then go.
- **Tab 4 (integrity, also edits `claude.js` / `codex.js` / `opencode-plugin.js`):**
  - My changes are confined to the `missed_turns` / `turn` lines, the one-line `missed_turns = 0` in each fresh-session branch, and OpenCode's new `tool.used` / `session.error` events and the `execute.after` hooks.
  - If your session reset rewrites those fresh-session branches, keep `missed_turns = 0` there.
- **Tab 2 (codex):**
  - Codex miss detection now needs a non-`update_plan` PostToolUse in the turn.
  - If the new Codex route reports tasks some other way (not `update_plan`), apply the same "a list change resets `missed_turns`" rule there.
- **Tab 5 (design):** no request. If tasks move to agent-native data, the turn semantics above are the behaviour to keep.

## Open issues

- **OpenCode v1 `tool.execute.after` shape** (`input.tool`, `input.sessionID`) follows the documented v1 plugin API. It was not checked against a running v1 host. Same for the v2 `execute.after` event's `tool` field on non-todowrite tools. If either is absent, OpenCode turns never count as missed: it fails quiet, with no false badge.
- **Claude interrupts:** an interrupted Claude turn fires no Stop. Its open turn is replaced at the next prompt, so it never counts. That was not changed.
- **Not tested on Windows.** The `/c/...` path conversion is unit-tested with `platform: "win32"`.
