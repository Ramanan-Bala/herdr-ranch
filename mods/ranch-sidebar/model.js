/**
 * Pure tree model for the Ranch sidebar.
 * Imports only ./lib/* — no herdr globals, no Date.now().
 * `now` is always passed in so tests can pin time.
 */

import { mostUrgent, folderLabel, statusSince } from "./lib/format.js";

/**
 * Build the sidebar tree from live Herdr data.
 *
 * @param {{
 *   machines: Array<{name: string|null, layout: "loading"|"ready"|"unavailable"}>,
 *   spaces: Array<{id, name, machine: string|null, active, status, tabs: Array}>,
 *   agents: Array<{address, tab, program}>,
 *   panes: Array<{tab, cwd, branch, program}>,
 *   filter: string|null,
 *   now: number,
 * }} input
 * @returns {{
 *   showMachines: boolean,
 *   groups: Array<{
 *     machine: string|null,
 *     label: string,
 *     state: "loading"|"ready"|"unavailable",
 *     blocked: number,
 *     spaces: Array<{
 *       space: string, name: string, active: boolean, status: string|null,
 *       blocked: number, cards: Array, settled: Array,
 *     }>,
 *   }>,
 * }}
 *
 * Card: { tabId, spaceId, spaceName, active, spaceActive, machine, repo,
 *         branch, detached, cwd, status, label, since, agentIcon,
 *         primaryAgent }.
 * `active` is space.active && tab.active; `spaceActive` is space.active alone.
 * `agentIcon` is the Program object (use .icon/.tint in the view).
 * `detached` here only means "the pane reports no branch"; real detached-HEAD
 * state comes from the git summary in main.js.
 */
export function buildTree({ machines, spaces, agents, panes, filter, now, home = null }) {
  machines = machines ?? [];
  spaces = spaces ?? [];
  agents = agents ?? [];
  panes = panes ?? [];

  // Machine order: machines() order (deduped), then any machine a space
  // references that machines() does not know about.
  const layouts = new Map();
  const order = [];
  for (const m of machines) {
    if (!layouts.has(m.name)) {
      layouts.set(m.name, m.layout);
      order.push(m.name);
    }
  }
  for (const s of spaces) {
    if (!layouts.has(s.machine)) {
      layouts.set(s.machine, "unavailable");
      order.push(s.machine);
    }
  }

  const paneByTab = new Map();
  for (const p of panes) {
    if (p.tab !== null && p.tab !== undefined && !paneByTab.has(p.tab)) {
      paneByTab.set(p.tab, p);
    }
  }
  const agentByTab = new Map();
  for (const a of agents) {
    if (a.tab !== null && a.tab !== undefined && !agentByTab.has(a.tab)) {
      agentByTab.set(a.tab, a);
    }
  }

  const match = (status) => !filter || status === filter;

  const groups = [];
  for (const machine of order) {
    const groupSpaces = [];
    for (const space of spaces) {
      if (space.machine !== machine) continue;

      const cards = [];
      const settled = [];
      for (const tab of space.tabs ?? []) {
        if (!match(tab.status)) continue;
        const pane = paneByTab.get(tab.id) ?? null;
        const agent = agentByTab.get(tab.id) ?? null;
        const card = {
          tabId: tab.id,
          spaceId: space.id,
          spaceName: space.name,
          active: !!space.active && !!tab.active,
          spaceActive: !!space.active,
          machine: space.machine,
          // "~" at home (R-SB-5), never the user's own folder name; only this
          // computer's home is known, so remote cards keep the folder name.
          repo: folderLabel(pane?.cwd ?? null, space.machine ? "" : home ?? ""),
          branch: pane?.branch ?? null,
          detached: pane ? !pane.branch : false,
          cwd: pane?.cwd ?? null,
          status: tab.status,
          label: tab.name,
          since: statusSince(tab, now),
          agentIcon: agent?.program ?? pane?.program ?? null,
          primaryAgent: agent?.address ?? null,
        };
        if (tab.settled) settled.push(card);
        else cards.push(card);
      }
      if (!cards.length && !settled.length) continue;

      const statuses = [...cards, ...settled].map((c) => c.status);
      groupSpaces.push({
        space: space.id,
        name: space.name,
        active: !!space.active,
        status: mostUrgent(statuses),
        blocked: statuses.filter((s) => s === "blocked").length,
        cards,
        settled,
      });
    }
    if (!groupSpaces.length && (filter || !layouts.has(machine))) continue;

    const blocked = groupSpaces.reduce((n, s) => n + s.blocked, 0);
    groups.push({
      machine,
      label: machine ?? "This Mac",
      state: layouts.get(machine),
      blocked,
      spaces: groupSpaces,
    });
  }

  return { showMachines: groups.length > 1, groups };
}

/**
 * Nest worktree spaces under their main checkout's space (display only; the
 * input order and Herdr's spaces are never changed). `infoOf(sp)` returns
 * `{common, linked}` (usually the git summary, which carries both) or null
 * when the space is not a repo or is still unknown. A linked entry nests
 * under the first non-linked entry in the array with the same `common`, in
 * original order, the last one drawn with "└─" and the others "├─"; a linked
 * entry with no main stays top-level. Never mutates the inputs.
 *
 * @param {Array<object>} spaces entries as buildTree returns them
 * @param {(sp: object) => {common: string|null, linked: boolean}|null} infoOf
 * @returns {Array<object>} shallow copies with `worktrees: Array` and `tree`
 *   (null, or "├─"/"└─" on nested entries).
 */
export function nestWorktrees(spaces, infoOf) {
  const infos = spaces.map((sp) => infoOf(sp) ?? null);
  const mains = new Set(
    infos.filter((inf) => inf && !inf.linked).map((inf) => inf.common)
  );
  const nested = (inf) => inf !== null && inf.linked && mains.has(inf.common);
  const out = [];
  const placed = new Set(); // commons whose worktrees are already nested
  for (let i = 0; i < spaces.length; i++) {
    const inf = infos[i];
    if (nested(inf)) continue;
    const entry = { ...spaces[i], worktrees: [], tree: null };
    out.push(entry);
    if (!inf || inf.linked || placed.has(inf.common)) continue;
    placed.add(inf.common);
    const kids = [];
    for (let j = 0; j < spaces.length; j++) {
      if (nested(infos[j]) && infos[j].common === inf.common) kids.push(j);
    }
    kids.forEach((j, n) => {
      entry.worktrees.push({ ...spaces[j], worktrees: [], tree: n === kids.length - 1 ? "└─" : "├─" });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Kept (dormant) folders
//
// Herdr closes a space the moment its last tab closes, and a mod cannot keep an
// empty space alive. So Ranch remembers the folders itself: a live space
// refreshes a "kept" entry (machine + folder, plus its display name, whether it
// was named and its custom colour); when no live space matches, the entry is
// drawn as a dimmed "dormant" row that reopens the folder. Dormant rows are
// appended at the end of their machine group (position tracking across the
// space list is not worth its complexity here). Linked git worktrees are never
// stored in the kept list itself; instead, worktrees are listed from a git
// scan of their main checkout, so a closed worktree still shows a dormant row
// under its project while its main checkout keeps one.
// ---------------------------------------------------------------------------

/**
 * The key that identifies a kept folder: its machine and folder. A `|`
 * separates them (the same convention lib/git.js uses for machine-scoped keys).
 * @param {string|null|undefined} machine
 * @param {string|null|undefined} folder
 * @returns {string}
 */
export function keptKey(machine, folder) {
  return `${machine ?? ""}|${folder ?? ""}`;
}

/**
 * The folder of a live space's first terminal: the live cwd of its first pane
 * (its tabs in order, the first one with a cwd), or null when no terminal of
 * the space is alive any more. Mirrors ranch-launch's place() so both mods
 * agree.
 * @param {{tabs?: Array<{id: string}>}|null} space
 * @param {Array<{tab: string, cwd: string|null}>} panes
 * @returns {string|null}
 */
export function spaceCwd(space, panes = []) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  return (panes ?? []).find((p) => tabs.has(p.tab) && p.cwd)?.cwd ?? null;
}

/**
 * The folder a live space is in: the live cwd of its first pane, else where the
 * space was made (`SpaceInfo.folder`). Herdr's SpaceInfo.folder is where its
 * new terminals start, not where the space is now (a space made in one folder
 * and moved with `cd` keeps the old one), so callers that record a space should
 * prefer `spaceCwd` and treat this fallback as a degraded reading.
 * @param {{tabs?: Array<{id: string}>, folder?: string|null}|null} space
 * @param {Array<{tab: string, cwd: string|null}>} panes
 * @returns {string|null}
 */
export function spaceFolder(space, panes = []) {
  if (!space) return null;
  return spaceCwd(space, panes) || space.folder || null;
}

/**
 * The folder a live space is read as this render, and whether that reading is
 * degraded: the last terminal is gone (no pane cwd: Herdr then reports the
 * folder it was made in, or the machine's home) or the pane's folder flipped
 * back to home while the space had another one (a dying terminal falls back).
 * A degraded reading must never be recorded or used to change a kept entry;
 * the caller remembers one folder per space id and passes it as `remembered`.
 * `created` is SpaceInfo.folder, used only when nothing better is known.
 * @param {{cwd?: string|null, remembered?: string|null,
 *   created?: string|null, home?: string|null}} [o]
 * @returns {{folder: string|null, degraded: boolean}}
 */
export function liveSpaceFolder({ cwd = null, remembered = null, created = null, home = null } = {}) {
  const rem = typeof remembered === "string" && remembered ? remembered : null;
  const live = typeof cwd === "string" && cwd ? cwd : null;
  if (live) {
    if (rem && !samePath(rem, home) && samePath(live, home)) {
      return { folder: rem, degraded: true };
    }
    return { folder: live, degraded: false };
  }
  const fallback = rem || (typeof created === "string" && created ? created : null);
  return { folder: fallback, degraded: true };
}

/**
 * The git state of every space in a decorated tree (main.js decorate writes
 * `top` on each card and `checkout` on each space). A card's `top` is undefined
 * while its folder's git lookup is unresolved, null when the folder is not a
 * repository and the top-level path otherwise. A space counts as resolved only
 * when every card that has a folder has an answer (and at least one does), so
 * an unresolved space is never recorded under a raw folder that a later render
 * would replace with the git top (or, for a linked worktree, drop entirely).
 *
 * @param {{groups?: Array<{spaces?: Array<object>}>}|null} tree
 * @returns {Map<string, {resolved: boolean, linked: boolean, top: string|null}>}
 */
export function spaceGitState(tree) {
  const out = new Map();
  for (const g of tree?.groups ?? []) {
    for (const sp of g.spaces ?? []) {
      const cards = [...(sp.cards ?? []), ...(sp.settled ?? [])];
      const withCwd = cards.filter((c) => c && c.cwd);
      const resolved = withCwd.length > 0 && withCwd.every((c) => c.top !== undefined);
      const co = resolved ? sp.checkout : null;
      out.set(sp.space, {
        resolved,
        linked: !!co?.linked,
        top: co?.top ?? null,
      });
    }
  }
  return out;
}

/**
 * Normalizes the persisted kept-folder list: drops anything that is not a
 * plain object with a non-empty string folder, coerces `machine` to a string
 * (null stays null), fills in a display name and dedupes by machine+folder
 * (first wins). Never throws on junk storage.
 * @param {unknown} parsed the JSON.parse result from localStorage
 * @returns {Array<{machine: string|null, folder: string, raw: string|null,
 *   name: string, named: boolean, color: string|null}>}
 */
export function normalizeKept(parsed) {
  if (!Array.isArray(parsed)) return [];
  const out = [];
  const seen = new Set();
  for (const e of parsed) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    if (typeof e.folder !== "string" || !e.folder) continue;
    const machine = e.machine == null ? null : String(e.machine);
    const key = keptKey(machine, e.folder);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      machine,
      folder: e.folder,
      raw: typeof e.raw === "string" && e.raw ? e.raw : null,
      name: typeof e.name === "string" && e.name ? e.name : e.folder,
      named: !!e.named,
      color: typeof e.color === "string" && e.color ? e.color : null,
    });
  }
  return out;
}

/**
 * Refreshes the kept list from this render's live spaces. Each live entry is
 * `{machine, folder, raw?, name, named, color}` where `folder` is the git
 * top-level when known and `raw` the space's own folder. Entries are matched by
 * machine+folder, so a space does not get a second dormant row after its top
 * resolves; an entry recorded before its top was known (its folder is still its
 * raw) may be re-keyed, but only while the live space's top is a proper ancestor
 * of that raw. Anything else appends a new entry.
 *
 * The kept list is lossless: an entry leaves it only through an explicit
 * Forget (`forgetKept`), an exact duplicate of another entry's machine+folder,
 * or a linked worktree (`exclude`) recorded from that very checkout. A live
 * space is never used to drop or re-key an entry onto a different folder: two
 * live spaces in one repo still share one entry, but two kept folders never
 * merge into one.
 *
 * A live entry flagged `degraded` (no live terminal, or a folder that fell back
 * to home) or explicitly `resolved: false` is ignored here: it says nothing
 * about the space's folder. `exclude` lists live linked git worktrees
 * (`{machine, folder, raw?}`, folder = its top): a linked worktree is never
 * kept on its own, so an entry recorded from it is pruned here. Pruning matches
 * the worktree top exactly and only on its own machine.
 *
 * @param {Array<object>} kept
 * @param {Array<{machine: string|null, folder: string, raw?: string|null,
 *   name?: string, named?: boolean, color?: string|null, degraded?: boolean,
 *   resolved?: boolean}>} live
 * @param {Array<{machine: string|null, folder?: string|null,
 *   raw?: string|null}>} [exclude]
 * @returns {{list: Array<object>, changed: boolean}}
 */
export function refreshKept(kept, live, exclude = []) {
  const worktrees = worktreeTops(exclude);
  const list = [];
  const seen = new Set();
  const byKey = new Map(); // machine|folder -> index in list
  const byRaw = new Map(); // machine|raw -> index in list
  let changed = false;
  for (const e of kept ?? []) {
    if (!e || typeof e.folder !== "string" || !e.folder) continue;
    const key = keptKey(e.machine, e.folder);
    if (seen.has(key)) continue;
    seen.add(key);
    if (recordedFromWorktree(e, worktrees)) {
      changed = true;
      continue;
    }
    const entry = { ...e };
    byKey.set(key, list.length);
    if (entry.raw) byRaw.set(keptKey(entry.machine, entry.raw), list.length);
    list.push(entry);
  }

  for (const l of live ?? []) {
    if (!l || typeof l.folder !== "string" || !l.folder) continue;
    if (l.degraded || l.resolved === false) continue;
    const machine = l.machine == null ? null : String(l.machine);
    const key = keptKey(machine, l.folder);
    let i = byKey.get(key);
    // The same space, recorded before its git top was known: its raw is the
    // entry's folder. Only a proper ancestor top re-keys it; an unrelated
    // folder is a different space and gets its own entry.
    if (i === undefined && l.raw) {
      const j = byRaw.get(keptKey(machine, l.raw));
      if (j !== undefined && list[j].folder === list[j].raw && pathInside(l.raw, l.folder)) {
        i = j;
      }
    }
    if (i === undefined) {
      const entry = {
        machine,
        folder: l.folder,
        raw: l.raw ?? null,
        name: l.name || l.folder,
        named: !!l.named,
        color: l.color ?? null,
      };
      list.push(entry);
      byKey.set(key, list.length - 1);
      if (entry.raw) byRaw.set(keptKey(entry.machine, entry.raw), list.length - 1);
      changed = true;
      continue;
    }
    const e = list[i];
    const next = {
      ...e,
      machine,
      folder: l.folder,
      raw: l.raw ?? e.raw ?? null,
      name: l.name || l.folder,
      named: !!l.named,
      color: l.color ?? null,
    };
    if (e.folder !== next.folder || e.raw !== next.raw || e.name !== next.name
      || e.named !== next.named || e.color !== next.color) {
      // Re-key: keep the maps pointing at this entry only under its new
      // folder/raw, or a later live space would be mismatched to the old one.
      if (e.folder !== next.folder && byKey.get(keptKey(e.machine, e.folder)) === i) {
        byKey.delete(keptKey(e.machine, e.folder));
      }
      if (e.raw !== next.raw && e.raw && byRaw.get(keptKey(e.machine, e.raw)) === i) {
        byRaw.delete(keptKey(e.machine, e.raw));
      }
      list[i] = next;
      changed = true;
    }
    byKey.set(key, i);
    if (next.raw) byRaw.set(keptKey(next.machine, next.raw), i);
  }
  return { list, changed };
}

/**
 * The kept entries that have no live space and should draw as dormant rows. A
 * kept entry belongs to a live space when, on the same machine, its `folder`
 * or `raw` equals the live `folder` or the live `raw`, or when the live raw
 * folder sits inside the kept folder *and* that live space's git top is not
 * resolved yet (a space opened in a subfolder: its live folder is still the raw
 * path, so it must not draw a duplicate dormant row beside the live space).
 * That last rule never applies to the machine's home (`home`), which contains
 * every folder.
 *
 * @param {Array<object>} kept
 * @param {Array<{machine: string|null, folder: string, raw?: string|null,
 *   resolved?: boolean}>} live
 * @param {{home?: string|null}} [options] this computer's home folder
 * @returns {Array<object>} the kept entries with no live space, in kept order
 */
export function dormantFolders(kept, live, { home = null } = {}) {
  const lives = (live ?? []).filter((l) => l && typeof l.folder === "string" && l.folder);
  return (kept ?? []).filter((e) => {
    if (!e || typeof e.folder !== "string" || !e.folder) return false;
    return !lives.some((l) => {
      if ((l.machine ?? "") !== (e.machine ?? "")) return false;
      if (l.folder === e.folder || l.raw === e.folder) return true;
      if (e.raw && (l.folder === e.raw || l.raw === e.raw)) return true;
      if (l.resolved) return false;
      if ((e.machine ?? null) === null && samePath(e.folder, home)) return false;
      return pathInside(l.raw, e.folder);
    });
  });
}

/**
 * machine -> set of folders from an exclude list (a linked worktree's top; its
 * raw path is not a top and never prunes anything).
 * @param {Array<{machine: string|null, folder?: string|null}>} exclude
 * @returns {Map<string, Set<string>>}
 */
function worktreeTops(exclude) {
  const out = new Map();
  for (const x of exclude ?? []) {
    if (!x || typeof x.folder !== "string" || !x.folder) continue;
    const key = x.machine == null ? "" : String(x.machine);
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(x.folder);
  }
  return out;
}

/**
 * True when `entry` was itself recorded from a live linked worktree in `tops`:
 * its folder is exactly that top and its raw folder (where its terminal was)
 * is that top or inside it. An entry that merely shares a path is kept.
 * @param {object} entry
 * @param {Map<string, Set<string>>} tops
 * @returns {boolean}
 */
function recordedFromWorktree(entry, tops) {
  const set = tops.get(entry.machine ?? "");
  if (!set || !set.has(entry.folder)) return false;
  return !entry.raw || entry.raw === entry.folder || pathInside(entry.raw, entry.folder);
}

/** Two folders naming the same path (a root's lone separator is kept). */
function samePath(a, b) {
  const x = barePath(a);
  const y = barePath(b);
  if (!x || !y) return false;
  const win = /^[a-zA-Z]:[\\/]/.test(x) || /^[a-zA-Z]:[\\/]/.test(y);
  return win ? x.toLowerCase() === y.toLowerCase() : x === y;
}

/** A folder without trailing separators (a lone root stays), or null. */
function barePath(folder) {
  if (typeof folder !== "string" || !folder) return null;
  const bare = folder.replace(/[\\/]+$/, "");
  return bare || folder[0];
}

/** True when `folder` is strictly inside `parent` (either separator). */
function pathInside(folder, parent) {
  const child = barePath(folder);
  const dir = barePath(parent);
  if (!child || !dir || child === dir) return false;
  if (/[\\/]$/.test(dir)) return child.startsWith(dir); // a root like "/"
  return child.startsWith(`${dir}/`) || child.startsWith(`${dir}\\`);
}

/**
 * Removes one entry from the kept list (the dormant row's Forget button).
 * @param {Array<object>} kept
 * @param {string|null|undefined} machine
 * @param {string|null|undefined} folder
 * @returns {Array<object>} a new list without that entry
 */
export function forgetKept(kept, machine, folder) {
  const key = keptKey(machine, folder);
  return (kept ?? []).filter((e) => keptKey(e.machine, e.folder) !== key);
}

/**
 * Attaches dormant folders to a built tree. Each group gets a `kept` array (its
 * dormant entries in kept order, appended after the group's live spaces); a
 * machine that only has dormant folders but no tree group is added at the end
 * with state "unavailable". Never mutates the input tree.
 *
 * @param {{showMachines: boolean, groups: Array<object>}} tree
 * @param {Array<{machine: string|null}>} dormant
 * @returns {{showMachines: boolean, groups: Array<object>}}
 */
export function applyKeptFolders(tree, dormant) {
  const byMachine = new Map();
  for (const e of dormant ?? []) {
    const machine = e.machine ?? null;
    if (!byMachine.has(machine)) byMachine.set(machine, []);
    byMachine.get(machine).push(e);
  }
  const groups = (tree.groups ?? []).map((g) => ({ ...g, kept: byMachine.get(g.machine) ?? [] }));
  for (const [machine, entries] of byMachine) {
    if (groups.some((g) => g.machine === machine)) continue;
    groups.push({
      machine,
      label: machine ?? "This Mac",
      state: "unavailable",
      blocked: 0,
      spaces: [],
      kept: entries,
    });
  }
  return { ...tree, showMachines: groups.length > 1, groups };
}

/** Palette used for agent initials badges (theme token names). */
export const BADGE_COLORS = [
  "ansi1",
  "ansi2",
  "ansi3",
  "ansi4",
  "ansi5",
  "ansi6",
];

/** Up to two initials from a display name: "Jae Kim" -> "JK", "raven" -> "RA". */
export function initials(name) {
  const words = String(name ?? "")
    .split(/[-_ ]+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Deterministic palette index for an id (stable across renders). */
export function badgeColorIndex(id) {
  const text = String(id ?? "");
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % BADGE_COLORS.length;
}

/**
 * Five squares summarising a diff: proportional "add" (green) and "del"
 * (red) counts, padded to five with "none".
 */
export function diffSquares(add = 0, del = 0) {
  add = Math.max(0, Math.floor(Number(add) || 0));
  del = Math.max(0, Math.floor(Number(del) || 0));
  const total = add + del;
  if (total === 0) return ["none", "none", "none", "none", "none"];

  let nAdd = Math.round((add / total) * 5);
  let nDel = Math.round((del / total) * 5);
  // Anything nonzero gets at least one square.
  if (nAdd === 0 && add > 0) nAdd = 1;
  if (nDel === 0 && del > 0) nDel = 1;
  if (nAdd + nDel > 5) {
    if (nAdd >= nDel) nAdd = 5 - nDel;
    else nDel = 5 - nAdd;
  }
  const squares = [];
  for (let i = 0; i < nAdd; i++) squares.push("add");
  for (let i = 0; i < nDel; i++) squares.push("del");
  while (squares.length < 5) squares.push("none");
  return squares;
}

/**
 * How long a repo-root discovery that found no repository is trusted before
 * it is tried again (audit finding 16). lib/git.js cannot distinguish a
 * definite "not a repo" from a timeout/unreachable machine (both come back
 * null), so one window covers all negatives.
 */
export const TOP_OF_RETRY_MS = 30 * 1000;

/**
 * Whether a topOf entry may still be used without a new discovery.
 * Entries are `{ top: string|null, at: number }`: a positive result (top
 * truthy) is kept as today, a negative one is trusted only inside the
 * TOP_OF_RETRY_MS window so an offline machine is not asked every frame and
 * a "not a repo" is re-checked once the window passes.
 * @param {{top: string|null, at: number}|undefined} entry
 * @param {number} now
 * @returns {boolean}
 */
export function topOfFresh(entry, now) {
  if (!entry || typeof entry.at !== "number") return false;
  if (entry.top) return true;
  return now - entry.at < TOP_OF_RETRY_MS;
}

/**
 * Normalizes the persisted folding state (audit finding 12): each of the
 * four maps must be a plain object, anything else (null, array, string) is
 * replaced with {} while usable neighbours are preserved. Unknown keys are
 * dropped.
 * @param {unknown} parsed the JSON.parse result from storage
 * @returns {{m: object, s: object, w: object, settled: object}}
 */
export function normalizeCollapsed(parsed) {
  const out = { m: {}, s: {}, w: {}, settled: {} };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
  for (const key of Object.keys(out)) {
    if (plain(parsed[key])) out[key] = parsed[key];
  }
  return out;
}

/**
 * The 1-based index for Herdr's `space.move` / `tab.move` after reordering
 * `ids` (the full list in Herdr's order — for tabs that is every tab of the
 * space, settled ones included, because move positions count the whole list)
 * so `dragId` lands before or after `targetId`.
 *
 * @param {Array<string|number>} ids ids in Herdr's order
 * @param {string|number} dragId the row being dragged
 * @param {string|number} targetId the row it was dropped on
 * @param {"before"|"after"} place which side of the target
 * @returns {number|null} 1-based index, or null when either id is missing or
 *   the two are the same (nothing to move).
 */
export function moveIndex(ids, dragId, targetId, place) {
  if (ids.indexOf(dragId) === -1 || ids.indexOf(targetId) === -1 || dragId === targetId) return null;
  const rest = ids.filter((id) => id !== dragId);
  const pos = rest.indexOf(targetId) + (place === "after" ? 1 : 0);
  return pos + 1;
}

/**
 * What the checkout row (line 3 of an ordinary card, grouped tab or
 * worktree row) shows (audit finding 19): diff statistics follow
 * `line3`, PR badges follow `pr` alone, and the row renders when either
 * has something to show. `hasDiff`/`hasPr` already fold in the layout's own
 * suppression (grouped tabs draw neither) and in whether there is content.
 * @param {{line3: boolean, pr: boolean, hasDiff: boolean, hasPr: boolean}} o
 * @returns {{stats: boolean, pr: boolean, row: boolean}}
 */
export function cardRows({ line3, pr, hasDiff, hasPr }) {
  const stats = !!line3 && !!hasDiff;
  const showPr = !!pr && !!hasPr;
  return { stats, pr: showPr, row: stats || showPr };
}

/** The last segment of a checkout top path ("a/b\\c" -> "c"), or null. */
function topSegment(top) {
  if (!top) return null;
  const parts = String(top).split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * The name a worktree header shows. The main checkout (`primary`) is named by
 * its branch, or `detached @<head>` when its HEAD is detached; a linked
 * worktree by the last segment of its checkout top (the folder name). Both
 * fall back to `entry.name`, as does a missing checkout.
 * @param {{name: string, checkout: object|null}} entry
 * @param {boolean} primary
 * @returns {string|null}
 */
export function worktreeName(entry, primary) {
  const co = entry?.checkout ?? null;
  if (!co) return entry?.name ?? null;
  if (primary) {
    if (co.detached) return `detached @${co.head ?? ""}`;
    return co.branch ?? entry?.name ?? null;
  }
  return topSegment(co.top) ?? entry?.name ?? null;
}

/**
 * The branch label a worktree header's second line shows, or null when there
 * is nothing to add: no checkout, no branch, or the label would just repeat
 * the header's own name (`worktreeName`).
 * @param {string|null} name the header name (from `worktreeName`)
 * @param {{branch?: string|null, detached?: boolean, head?: string|null}|null} checkout
 * @returns {string|null}
 */
export function branchLine(name, checkout) {
  if (!checkout) return null;
  const label = checkout.detached
    ? `detached @${checkout.head ?? ""}`
    : checkout.branch ?? null;
  if (!label || label === name) return null;
  return label;
}

/**
 * The main checkout folder for a git common directory (e.g. `"/r/app/.git"`
 * -> `"/r/app"`). Strips one trailing `"/.git"` or `"\\.git"` (accepting
 * trailing separators). Returns null for empty/non-string input or a common
 * dir that does not end in `.git` (such as a bare repository).
 *
 * @param {string|null|undefined} common
 * @returns {string|null}
 */
export function mainCheckoutOf(common) {
  if (typeof common !== "string" || !common) return null;
  const trimmed = common.replace(/[\\/]+$/, "");
  if (!/[\\/]\.git$/.test(trimmed)) return null;
  return trimmed.slice(0, -5) || trimmed[0];
}

/**
 * Linked worktrees from a `parseWorktrees` scan that currently have no live
 * space on this machine. Filters out `main`, `bare`, and `prunable` entries
 * and any entry whose `path` matches `liveTops` (compared with trailing
 * separators stripped), sorted by `path`. Never mutates inputs.
 *
 * @param {Array<{path: string, branch?: string|null, detached?: boolean,
 *   bare?: boolean, prunable?: boolean, main?: boolean}>|null|undefined} scanned
 * @param {Set<string>|Array<string>|null|undefined} liveTops
 * @returns {Array<{path: string, branch: string|null, detached: boolean, name: string}>}
 */
export function dormantWorktrees(scanned, liveTops) {
  const live = new Set();
  for (const top of liveTops ?? []) {
    const bare = barePath(top);
    if (bare) live.add(bare);
  }
  const out = [];
  for (const wt of scanned ?? []) {
    if (!wt || typeof wt.path !== "string" || !wt.path) continue;
    if (wt.main || wt.bare || wt.prunable) continue;
    const bare = barePath(wt.path);
    if (!bare || live.has(bare)) continue;
    out.push({
      path: wt.path,
      branch: wt.branch ?? null,
      detached: !!wt.detached,
      name: topSegment(wt.path) ?? wt.path,
    });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}
