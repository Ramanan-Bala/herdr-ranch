# Fix set 3 (git caching): result

**Tab:** fix 3: git caching · **Worktree:** `~/Projects/ranch-worktrees/3-caching` · **Branch:** `fix/1211-caching` (base `bd639c6`, HEAD unchanged, nothing committed)
**Scope:** report 3 Options A + B (C skipped, D/E skipped), audit findings **9, 14, 15, 18**.

## Decisions taken with the person

| Question | Answer |
|---|---|
| Option B parallel git vs requirements.md:349 "one git process per repo" | Parallel, max 4 at once per read; requirements.md updated |
| gh budget split (4 total) | Sidebar 3 + Session 1 (branch PR jumps the queue) |
| Option C (share sidebar summaries) | Skip |
| Badge over cached data | "Updating…" while a read runs, dim "as of 40s" when older than the refresh interval |

## What changed

### `lib/git.js` (finding 18, Option B, finding 14 caches): synced to all 9 mods with `npm run sync`
- `lib/git.js:74` `parseNumstatZ`: parses `git diff --numstat -z`. Paths are verbatim (tabs, newlines, quotes, unicode, literal ` => `), and renames use the new path. `parseNumstat` (text) is kept for compatibility.
- `lib/git.js:106` `numstatTotals`: shortstat totals from numstat rows. Binary files count as files with 0 lines, so one `diff` call replaces `--shortstat` + `--numstat`.
- `lib/git.js:158` `parseStatusBranch`: reads `status --porcelain=v2 --branch` (oid, head, detached, upstream, ahead/behind; `(initial)` and a missing `branch.ab` give null).
- `lib/git.js:195` `webHost`: exact hostname match. GitHub only for `github.com`, `www.github.com` and `ssh.github.com` (base normalised to `github.com`). GitLab for `gitlab.com` or any label starting with `gitlab` (self-hosted support is unchanged). Lookalikes such as `github.com.example.test` now return null.
- `lib/git.js:254` `links().compare`: refs are encoded per path segment, as `branch()` already did.
- `lib/git.js:310` `defaultBranch`: after origin/HEAD it checks `refs/remotes/origin/<main|master>` before the local branch, so a clone that has only the remote branch now finds its default.
- `lib/git.js:346` `repoSnapshot(git, {commits, details, meta, metaKey, now})` returns `{status: "ok"|"not-repo"|"failed", summary, details}`. Rounds:
  1. `rev-parse --show-toplevel --path-format=absolute --git-common-dir` ‖ `--no-optional-locks status --porcelain=v2 --branch --untracked-files=no`
  2. (cached for 10 min per `metaKey|common-dir`) `for-each-ref …origin/HEAD,origin/main,origin/master,heads/main,heads/master` ‖ `remote get-url origin`
  3. `merge-base` ‖ `rev-list --left-right --count`
  4. `diff --numstat -z` ‖ `log`

  Warm: 6 calls in 3 rounds. Cold: 8 calls in 4 rounds. Never more than 2 processes at once. The summary shape is unchanged; the only difference is that `head` is the first 7 characters of the oid instead of `rev-parse --short`.
- `lib/git.js:486` `repoSummary` is now `repoSnapshot(…, {details: false}).summary` (warm: 5 calls). `lib/git.js:498` `repoDetails` uses `-z` and runs its two calls in parallel.
- `lib/git.js:633` `createTtlCache(ttl, {max})`: `get` deletes expired entries, plus `prune(now)`, `size` and LRU `max`.
- `lib/git.js:679` `createLimiter(max)`: FIFO with `{front: true}`. A throw or plain return value still frees the slot, and the slot is freed before the caller resumes.

### `lib/watch.js` (new, finding 14)
- `createWatchLoops({watch, onChange, sleep})`: at most one `watchFolder` loop per root. `add`/`remove`/`setWanted`. Re-adding a root whose wait is still pending reuses that loop. A loop exits on its next wake once the root is no longer wanted. It never rejects.

### `mods/ranch-session/gitctx.js` (new, findings 9 + 15, Option A)
- `GitContexts`: a bounded LRU (20) Git cache keyed `machine|cwd` and a PR cache keyed `machine|cwd|branch`. It has begin/finish ops that freeze the context `{key, machine, cwd, branch, gen}` and **always file results under the context that started them**. Views (`gitEntry`, `prEntry`, `pushView`) come only from the current context. Up to 3 git reads run at once across contexts, so a new tab no longer waits for the old tab's read. A failed refresh keeps the last good data. There is one push slot bound to its context; a stale completion (old id) is ignored. `ageLabel()` produces the "as of" text.

### `mods/ranch-session/main.js` (findings 9, 14, 15; Option A wiring)
- `:88` module-level `ghLimit = createLimiter(1)`. `:114` `this.ctx`, `gitMeta` (10-min metadata cache). `recordedPrCache` is capped at 100 and pruned in every pump.
- `:133` `gitWatch = createWatchLoops(...)` + `:545` `syncGitWatch()` replace `watchGit()`, which used to start a new loop on every refresh.
- `:524` `refreshGit` and `:550` `refreshPr` use `beginGit/finishGit` and `beginPr/finishPr`. The branch PR goes through `ghLimit` with `front: true`.
- `render()`, `pump()` (`:627`) and `pushBranch()` call `ctx.select(machine, cwd)` first, because render can run after a tab switch before the 1 s pump.
- `:871` action bar: PR link, compare link and push all come from the current context. PR readiness includes the branch.
- `:1028` `pushBranch`: captures `{machine, top, branch}` once and runs `git push -u origin <branch shown>` (previously `HEAD` in an unguarded `this.git.summary.top`).
- `:1163` `updating()`/`asOf()` badges. `:1174` `gitCard` and `:1382` `prCard` keep cached content on screen and show "Updating…" or "as of …". A failed read with no earlier data shows "Git unavailable".
- `:772` `prExtras` and `:1572` `recordedPrs` read only the current context's entry.
- No `this.git`, `this.pr`, `this.push` or `gitWatchGen` references remain (checked with grep).

### `mods/ranch-sidebar/main.js` (finding 14, sidebar part: watchers, cache pruning, PR queue only)
- `:27` module-level `ghLimit = createLimiter(3)`. `:313` drain claims each PR job (`prBusy`) and runs it through the limiter. This replaces the per-view batch of 4.
- `:53` `repoWatch = createWatchLoops(...)` replaces `watchRepo`/`this.watching`, which could leave two loops on one root after a sweep followed by a re-add.
- `:72`/`:145` `gitMeta` passed to `repoSummary` (13 → 5 calls warm).
- `:167` sweep drops positive `topOf` mappings for repos no longer wanted. `null` (not-a-repo) entries are left for tab 4 (finding 16). `:186` `prCache.prune(now)`, and both prCache instances are capped at 500.

### Other
- `requirements.md:349`: performance rule updated to match the agreed budget (one read per repo per view, at most 4 processes within it; gh: sidebar 3 + session 1).
- `test/integrity.test.js` (I4): fixture only. It fakes `ctx` instead of the removed `this.git` slot; the assertions are unchanged.

## Tests added (all written first; failures seen before each fix)

| File | Tests | Covers |
|---|---|---|
| `test/git.test.js` | +19 (21 → 40) | numstat -z (literal ` => `, tab/newline/quote/unicode, rename, binary); totals; exact hosts and lookalikes; encoded compare refs; remote-only default branch; porcelain-v2 parser (detached, unborn, no upstream, gone upstream); `repoSnapshot` call counts (warm 6, cold 8) and **max concurrency ≤ 4**; not-repo vs failed; metadata cache hit, and a failed for-each-ref is not cached; TTL get-deletes/prune/max; limiter FIFO, front, rejection and sync throw. 7 existing tests had only their fake command strings updated. |
| `test/watch.test.js` | 11 | 100× add gives one loop; remove then re-add while pending gives one loop; exit then re-add starts a new loop; error backoff; onChange throwing; setWanted ×100; the sidebar's sweep/re-add sequence. |
| `test/ranch-session-gitctx.test.js` | 15 | A→B→A cache hit (ready immediately and refreshing); uncached never shows another folder; late git/PR result files under its owner; B doesn't wait for A; inflight cap; eviction at 21; same-folder branch change hides the old PR; local vs remote with the same cwd; failed refresh keeps data; overlapping pushes and stale completions; ageLabel. |
| `test/ranch-session-wiring.test.js` | 5 | Loads the **real** `main.js` with `herdr`/`gpui-*` stubbed (`module.registerHooks`). Covers: deferred A read after switching to B; A→B→A ready with no await; same-folder branch change; push uses A's top, machine and branch after switching to B; late A PR not shown on B. |

**Mutation check.** Each old bug was reintroduced and caught: filing a git result under the current key → 2 failures; PR key without the branch → 4; push using the current session + `HEAD` → 1; stale push completion accepted → 1. The originals were restored byte-identical.

## Verification

```
Baseline (bd639c6, before changes):  npm test 272/272 pass · npm run check 9/9 passed
After:  npm run verify → exit 0 · tests 322, pass 322, fail 0 · check passed ×9
```
No failures remain, and none existed at baseline on macOS. The audit's 9 Windows failures did not reproduce here.

### Timings (this Mac, Node `child_process` running git directly; Herdr's own `exec` overhead in the live app was **not** measured)

| Read | Before | After |
|---|---|---|
| Session `repoSummary`+`repoDetails` / `repoSnapshot`, ranch repo | 138–168 ms, 13 calls | cold 53 ms (8 calls), warm 38–48 ms (6 calls) |
| Same, Unlatch repo | 143–151 ms, 13 calls | cold 77 ms, warm 37–46 ms |
| Sidebar `repoSummary` | 103–113 ms, 11 calls | cold 89 ms (7), warm 34–38 ms (5) |
| **Simulated** 400 ms per-process start (Windows-like) | 5.5–5.6 s | cold 1.7 s, warm 1.3 s |

The ≤2.5 s target is **not claimed as measured on Windows**. The 400 ms row is a simulation (a fixed delay before each process). Option A means a revisit within the last 20 contexts shows cached data with no wait.

## Deviations from the report / audit

- The report's "no tests" claim was wrong (the audit was right); new tests went under `test/`.
- The report's line numbers matched `bd639c6`. Additional facts found in the code: the `key !== key` guards in `refreshGit`/`refreshPr` could never trigger (the key only changes inside the busy-guarded call), so late results always landed in the single slot. The action bar, push, the PR failure notes and `recordedPrs` also read the slots with no readiness check.
- Push now pushes the branch shown (`git push -u origin <branch>`) instead of `HEAD`, so it can't push a different branch than the button named.
- `head` comes from the porcelain oid (first 7 characters) instead of `rev-parse --short`, which can be longer in big repos.
- Metadata (default branch, remote URL) can be up to 10 minutes stale, as the report proposed.
- A "gh missing" result is stored as `failed: true` with the error "GitHub CLI not found" (same visible text as before).
- Orchestration: I made small edits myself in four places:
  - Fixed the limiter (sync throw, slot release order) with a new test.
  - Fixed two badge details in `main.js`.
  - Fixed the hanging wiring-test harness: it never installed its fake `exec`.
  - Updated the I4 fixture.

  The U4 worker had repeatedly stopped on permission prompts; each edit was a few lines.

## Live-data / instruction proposals for the person

None needed. No live data, config or instructions were touched. When you install, run `npm run sync` and reload the layout as usual (not done here, per the rules).

## Cross-tab requests

- **Tab 4 (finding 16):** `repoSnapshot` now tells `"failed"` (runner error/timeout) apart from `"not-repo"`. The sidebar's `refreshRepo` can use `repoSnapshot(…, {details: false})` instead of `repoSummary` to stop caching `null` on a timeout. I left `topOf` null handling and `scheduleGit` untouched; only positive `topOf` entries are pruned in `sweep`.
- **Tab 1 (Bug 1 / finding 8):** `recordedPrs()` in `ranch-session/main.js` now reads top/branch from `this.ctx.gitEntry()` (guarded) instead of `this.git.top`/`this.git.summary`. Expect a small conflict there; keep the guarded read when rebasing. Also, `test/integrity.test.js` I4 now fakes `ctx` instead of `git`.
- **Anyone touching `ranch-session/main.js` Git/PR code:** `this.git`, `this.pr`, `this.push` and `this.pushAt` no longer exist. Use `this.ctx` (`gitctx.js`).
- **Merge order:** as in the README (after 4's data-safety part and 1).

## Open issues / deferred

- **Finding 14, `namer.js` maps** (`stores`, `modelTitles`, `modelTried` grow with every agent/session seen): deferred. It's small, not Git-related, and sits next to tab 1's rename work.
- **Finding 14, Usage collector lifecycle** (`ranch-usage`): deferred. Not in this tab's brief (session/sidebar only); suggest tab 4 or a follow-up.
- **Cross-mod gh budget:** each mod has its own module-level limiter (3 + 1 = 4). I haven't verified whether hidden layout copies of the same mod share a JS module scope. If they don't, the bound is per copy. `shared()` is persisted and re-renders every mod, so it can't act as a lock.
- **Watchers:** a pending `watchFolder` can't be cancelled. After you leave a repo, its single loop stays pending until that repo's next change, then exits. That's bounded at one per root and never duplicated.
- **Not tested in the live Herdr app:** the A→B→A switch with no "Refreshing…", the badge look, and remote machines. The wiring test drives the real `main.js` with stubs, but nobody has looked at it in the app yet.
- The sidebar now claims all queued PR jobs at once (into the limiter), so a job for a card that has since scrolled away still runs once.
