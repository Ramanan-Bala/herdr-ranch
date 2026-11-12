<!--
Transcribed from "3. session-git-caching-improvemnt.pdf" (4 phone photos of
`herdr-ranch-session-git-caching.md` open in an editor on a Windows machine).
Source line numbers ran 1-210. Editor ligatures were written as ASCII (`=>`, `!==`, `===`, `->`).
-->

# Herdr Ranch - Session Details: stop showing "Refreshing…" on every tab switch

**Component:** Ranch Session Details panel (`ranch-session` mod)
**Status:** Proposal, not implemented yet
**Date:** 2026-11-12

---

## 1. The problem

Each time you switch tabs, the **Git** card (and then the **PR** card) shows
**"Refreshing…"** for several seconds. This happens even when you switch back to a
tab you looked at seconds ago. The panel forgets everything about a folder once
you leave it, then starts a full, slow git read from the beginning.

## 2. How it works today

File: `~/.config/herdr-app/mods/ranch-session/main.js`

| Step | Code | What happens |
|---|---|---|
| 1 | `init` L105 | A single slot holds git state: `this.git = { key, summary, details, top, busy, dirty, at, readyKey }`. It covers **one folder at a time**. |
| 2 | `pump` L630-633 (runs every 1 s) | A tab switch changes `machine\|cwd`, which sets `git.dirty = true` and `pr.dirty = true`, and **clears `pr.parsed`**. |
| 3 | `gitReady` L1184-1186 | Ready only when `git.readyKey === machine\|cwd`. A new folder is never ready, so the Git card shows "Refreshing…" (L1213) and hides the summary (L914). |
| 4 | `pump` L680 -> `refreshGit` L509-543 | Runs `repoSummary` + `repoDetails` (`lib/git.js` L226-326). **Skipped while `git.busy`**, so a read that is still running for the previous tab has to finish before the new tab's read can start. |
| 5 | `pump` L689 -> `refreshPr` | Waits until git is ready for the new folder (I7). Then it runs `gh pr view`. Until that finishes, the PR card shows "Refreshing…" too (L1402-1407). |
| 6 | `watchGit` L546 | Watches only the folder on screen. The watcher is replaced on every switch. |

The sidebar (`ranch-sidebar/main.js` L104-175) **already** keeps a per-repo
`repoSummary` cache (`this.repos`, keyed `machine|top`). It has file watchers and
refreshes every 30 s. The session panel cannot use it and computes the same data
again.

## 3. Measured cost (this machine, `C:\Raptor\raptor-forms-render`)

Each git process takes **~300-700 ms** to start on this laptop (Windows plus endpoint
security), whatever the command does:

```
 342 ms  git rev-parse --show-toplevel
 367 ms  git branch --show-current
 436 ms  git rev-parse --short HEAD
 726 ms  git symbolic-ref --short refs/remotes/origin/HEAD
 369 ms  git rev-parse --verify --quiet refs/remotes/origin/master
 373 ms  git merge-base HEAD origin/master
 400 ms  git rev-list --left-right --count HEAD...origin/master
 320 ms  git rev-list --left-right --count HEAD...@{u}
 340 ms  git remote get-url origin
 315 ms  git rev-parse --path-format=absolute --git-common-dir
 469 ms  git diff --shortstat <base>
 528 ms  git diff --numstat <base>        (repoDetails)
 434 ms  git log -n 5 <base>..HEAD        (repoDetails)
TOTAL 5846 ms   (13 calls, one after another)
```

Running 6 of these calls in parallel took 3.5 s, compared with 7.1 s one after another
using the same launcher. Running in parallel helps (about 2x), but process start is
still the main cost.

## 4. Root causes

1. **No per-folder memory.** `this.git` and `this.pr` hold one folder only. A switch
   throws away the old data. Switching back reads everything again.
2. **Each read is slow.** It makes 13 git calls one after another (about 6 s here). Then
   `gh pr view` runs (about 1-3 s). The PR card waits for both.
3. **A new tab waits for the old tab's read.** `refreshGit` does not start while
   `busy`. If you switch during a read, you can wait up to twice as long
   (the old read finishes, then the new one runs).
4. **Duplicate work.** The sidebar already has a fresh `repoSummary` for every
   visible tab's repo, but the panel does not use it.
5. **The badge cannot tell old data from missing data.** "Refreshing…" replaces the
   content. So "I have data from 20 s ago and am checking it" looks the same as
   "I have nothing".

## 5. Options

| Option | What it is | Gain | Cost / risk |
|---|---|---|---|
| **A. Per-folder cache in the panel, shown first and updated in the background** | Keep a small `Map` of recent folders (git + PR). On switch, show the cached data at once and update it in the background. | Switching back to a seen tab shows data in **0 ms**. Most of the problem goes away. | Small change (one file). Data can be a few seconds old until the update finishes. The panel shows how old it is. |
| **B. Fewer git calls per read** | Merge calls (details below) and run independent calls in parallel. | First visit and background updates take about 2-3 s instead of about 6 s. Every update also gets cheaper. | Touches `lib/git.js`, which is copied into ranch-session, ranch-sidebar and ranch-files. Each copy needs the same edit, or the source lib needs it. Needs parser tests. |
| **C. Share the sidebar's summaries** | The sidebar publishes `this.repos` with `setShared("ranch.repoSummaries", …)`. The panel uses them for the first paint when it has no cache. | Fast first visit for repos the sidebar has already read. | Ties the two mods together. The sidebar keys by `top` and the panel by `cwd`, so the panel needs the sidebar's `topOf`. Only the summary is shared, not files or commits. Not verified: how expensive `shared` is for large objects. |
| **D. Cache on disk** (`~/.herdr/ranch/cache/git.json`) | Keeps data across app restarts. | Fast first paint after a restart. | Data can be very old, plus file I/O and cleanup work. **Not recommended.** |
| **E. Poll every tab in the background** | Keep all open tabs' git fresh. | Always warm. | Scales with the number of tabs and costs about 6 s of git per tab per cycle. **Not recommended.** The sidebar already does a lighter version (summary only). |

**Recommendation:** do **A** first, which fixes the visible problem. Then do **B**,
which makes every read cheaper. **C** is optional. Skip **D** and **E**.

## 6. Proposed fix

### 6.1 Option A: per-folder cache, shown first and updated in the background (`ranch-session/main.js`)

**State** (in `init`, next to L105-107):

```js
this.gitCache = new Map(); // `${machine}|${cwd}` -> { summary, details, top, at }
this.prCache = new Map();  // `${machine}|${cwd}|${branch}` -> { parsed, failed, error, at }
const CACHE_MAX = 20;      // most recent folders; evict oldest (Map keeps insertion order)
```

**On tab switch** (`pump`, in the `key !== this.sessionKey` block at L630):

```js
const hit = this.gitCache.get(key);
if (hit) {
  // Show this folder's own last read at once; never another folder's data.
  Object.assign(this.git, { summary: hit.summary, details: hit.details, top: hit.top, at: hit.at, readyKey: key });
}
this.git.dirty = true; // still update in the background

const prHit = hit && this.prCache.get(`${key}|${hit.summary?.branch ?? ""}`);
if (prHit) Object.assign(this.pr, { parsed: prHit.parsed, failed: prHit.failed, error: prHit.error, readyFor: key });
else { this.pr.parsed = null; this.pr.failed = false; this.pr.error = null; } // today's behaviour
```

**In `refreshGit`**, always write the result to the cache. Update the panel only
if the folder is still on screen. A read that finishes for a tab you have left
still fills that tab's cache, so it is not wasted:

```js
const key = `${s.machine ?? ""}|${s.cwd}`;
// ...await repoSummary / repoDetails...
remember(this.gitCache, key, { summary, details, top: summary?.top ?? null, at: Date.now() });
if (this.sessionKey !== key) { this.git.busy = false; this.git.dirty = true; return; } // the user moved on; pump reads the new folder next
// ...existing assignment to this.git...
```

`refreshPr` does the same with `prCache`, keyed `machine|cwd|branch`.

`remember(map, k, v)` = `map.delete(k); map.set(k, v); if (map.size > CACHE_MAX) map.delete(map.keys().next().value);`

**Badge** (`gitCard` L1213, PR card L1402):

- **No cache entry:** keep "Refreshing…" as it is today.
- **Showing cached data while an update runs:** keep the content on screen and show a
  small "Updating…" (or a spinner only) in the header. The layout does not move.
- **Cached data older than the refresh interval:** optionally add a dim "as of 40s"
  next to the card title.

`gitReady` keeps its meaning (true when data for *this* folder is on screen), so its
other callers (L914, `prReady`) need no change.

**Keep these invariants:**

- **I7, never show another repo's branch:** the cache key is the exact
  `machine|cwd`, so a hit always belongs to this folder.
- **PR waits for git (I7):** with a cache hit, git is ready immediately, so the PR
  update may start with the *cached* branch. If the git update then finds a
  different branch, `prKey` changes (L685-686) and the PR is fetched again. This
  works as it does today, a few hundred ms later.
- **A changed branch is shown on the next update** (1-6 s), never permanently.

### 6.2 Option B: fewer git calls per read (`lib/git.js` `repoSummary` / `repoDetails`)

| Today (calls) | Replace with | Calls |
|---|---|---|
| `branch --show-current`, `rev-parse --short HEAD`, `rev-list HEAD...@{u}` (3) | `git --no-optional-locks status --porcelain=v2 --branch --untracked-files=no`, which gives the `# branch.oid`, `# branch.head`, `# branch.upstream` and `# branch.ab +A -B` lines | 1 |
| `rev-parse --show-toplevel`, `rev-parse --git-common-dir` (2) | `git rev-parse --show-toplevel --path-format=absolute --git-common-dir` (prints one line per option) | 1 |
| `symbolic-ref origin/HEAD`, `rev-parse --verify` ×1-2, `remote get-url origin` (3-4) | **Cache per `top` for 10 min.** The default branch and the remote URL rarely change. | 0 (mostly) |
| `diff --shortstat` + `diff --numstat` (2) | Run only `diff --numstat` and add up the lines for the shortstat (files, insertions, deletions; binary files count as 0) | 1 |
| everything else | Run independent calls together with `Promise.all` (e.g. status, rev-parse and merge-base at the same time) | - |

Expected time for a warm read: about **5-6 calls in 2-3 rounds**, roughly **1.5-2.5 s**
instead of about 6 s. This is an estimate. Only the per-call cost and the 2x speedup
from running calls in parallel were measured.

Notes:

- `--no-optional-locks` stops `git status` from rewriting the index, so it does not
  wake the folder watcher (`watchFolder`) and cause another refresh.
- On a **remote machine** (`exec(..., { on: machine })`), running calls in parallel
  opens several remote commands at once. Limit this to 3-4 calls at a time.
- `lib/git.js` is copied into each mod. Make the edit in the shared source lib, or in
  all three copies, so the copies stay in sync.

### 6.3 Option C (optional): use the sidebar's summaries

- `ranch-sidebar/main.js` `refreshRepo` (L120-137): after `this.repos.set(...)`, publish
  `setShared("ranch.repoSummaries", { [`${m}|${top}`]: { summary, at }, ... })` and
  `setShared("ranch.repoTops", { [`${m}|${cwd}`]: top, ... })`. Remove an entry when the
  sidebar's `sweep` drops it.
- `ranch-session` `pump`: when there is no `gitCache` hit, look up `repoTops[key]` and then
  `repoSummaries[...]`. Use the summary (branch, ahead/behind, stat) at once. Files and
  commits still show "Refreshing…" until `repoDetails` finishes.
- Trade-off: this ties the two mods together. It is worth it only if first-visit speed
  still matters after A and B.

## 7. Tests

`~/.herdr/ranch` has no test files today. Add small unit tests next to the logic:

1. **Cache hit on switch:** A -> B -> A shows A's summary right away (`gitReady` is true
   on the first `pump`) and starts a background refresh.
2. **No cross-folder data:** switching to a folder that is not cached shows
   "Refreshing…", never the previous folder's summary.
3. **A late result goes to the right place:** a read for A that finishes after the
   switch to B fills `gitCache[A]` and leaves `this.git` (B) unchanged.
4. **Eviction:** after 21 folders, the oldest entry is gone.
5. **Parsers (Option B):** `status --porcelain=v2 --branch` gives the same branch, head
   and ahead/behind as the old 3 calls, including a detached HEAD (`# branch.head
   (detached)`) and no upstream (`# branch.ab` missing -> `ahead/behind = null`). The
   numstat sum equals `--shortstat` on a sample diff.

## 8. Rollout order

1. Option A only (one file, `ranch-session/main.js`). Check it by switching between
   two tabs on different repos: the second visit shows data with no "Refreshing…".
2. Option B in `lib/git.js` with the parser tests. Then time `repoSummary` again
   (target ≤ 2.5 s cold on this machine).
3. Option C only if the first visit is still too slow.
