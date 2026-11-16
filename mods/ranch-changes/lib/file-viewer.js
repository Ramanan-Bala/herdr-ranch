// The Ranch file viewer tab: one read-only file at a time, shown as its own
// Herdr tab (a tab whose only pane is the ranch-files mod) and drawn in the top
// bar as a closable file tab. Anyone opens a file by setting VIEWER_KEY; the
// top bar opens or selects the tab, the viewer copy of ranch-files draws the
// file. No imports: copied into every mod by scripts/sync-lib.sh.

/** shared() key: `{ abs, on, nonce }` — the file the viewer tab shows. */
export const VIEWER_KEY = "ranch.files.viewer";
export const VIEWER_MOD = "ranch-files";

/**
 * The viewer tab in a space: a tab whose only pane is the ranch-files mod.
 * A ranch-files pane split beside a terminal does not count (its tab has other panes).
 * @param {{tabs?: Array<{id: string}>}|undefined} space
 * @param {Array<{tab: string, mod?: string}>} paneList
 * @returns {object|null} the tab
 */
export function viewerTab(space, paneList) {
  for (const tab of space?.tabs ?? []) {
    const inTab = paneList.filter((p) => p.tab === tab.id);
    if (inTab.length === 1 && inTab[0].mod === VIEWER_MOD) return tab;
  }
  return null;
}

/** Whether a tab is a viewer tab (see viewerTab). */
export function isViewerTab(tab, paneList) {
  const inTab = paneList.filter((p) => p.tab === tab?.id);
  return inTab.length === 1 && inTab[0].mod === VIEWER_MOD;
}

/** A path's last segment (either separator). */
export function baseName(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean).pop() ?? "";
}

/** The shared value that opens `abs` in the viewer tab. */
export function viewerRequest(abs, on, nonce = Date.now()) {
  return { abs, on: on ?? null, nonce };
}

/**
 * What the top bar does for a new viewer request in the active space: select
 * and rename the existing viewer tab, or create one. Returns the run() calls.
 * @returns {Array<[string, object]>}
 */
export function openViewerCommands(space, paneList, request) {
  if (!space || !request?.abs) return [];
  const name = baseName(request.abs);
  const tab = viewerTab(space, paneList);
  if (tab) {
    const calls = [["tab.select", { id: tab.id }]];
    if (tab.name !== name) calls.push(["tab.rename", { id: tab.id, name }]);
    return calls;
  }
  return [["tab.new", { space: space.id, name, mod: VIEWER_MOD, props: { viewer: true } }]];
}

/**
 * Panels follow the focused terminal's folder. A focused mod pane (the viewer
 * tab, a file split beside a terminal) has no folder of its own; without this
 * the panels would jump to the space's folder whenever a file opens. Returns
 * the location to show and remembers terminal locations per space in `last`.
 * @param {{cwd?: string|null, on?: string|null, space?: string|null}} computed
 * @param {{mod?: string, terminal?: string|null}|null} pane the focused pane
 * @param {Map<string, object>} last space id -> last terminal location
 */
export function stableLocation(computed, pane, last) {
  const space = computed?.space ?? null;
  if (pane?.mod && !pane.terminal) return last.get(space) ?? computed;
  last.set(space, computed);
  return computed;
}
