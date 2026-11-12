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
