// What the person chose to see on the bar; the hover panel always shows everything.
// Limits are opt-out lists, so anything new shows by itself. Session numbers are opt-in.
// Prefs: { hidden: [providerId], hiddenWindows: ["<providerId>:<windowId>"], showResetTime: bool,
//          showBars: bool, sessionOnBar: ["context"|"calls"|"compactions"] }
// showResetTime: every window shows its time to reset, not only amber and red ones.
// showBars: each limit has its bar when there's room; off, the bar shows numbers only.

const normalize = (p) => ({
  hidden: [...(p?.hidden ?? [])],
  hiddenWindows: [...(p?.hiddenWindows ?? [])],
  showResetTime: p?.showResetTime === true,
  showBars: p?.showBars !== false,
  showRemaining: p?.showRemaining === true,
  sessionOnBar: [...(p?.sessionOnBar ?? [])],
});

// Saved choices win once they exist; until then the layout's props preset them.
export function effectivePrefs(saved, props) {
  return normalize(saved ?? props);
}

export function isShown(prefs, providerId, windowId) {
  if (prefs.hidden.includes(providerId)) return false;
  return windowId == null || !prefs.hiddenWindows.includes(`${providerId}:${windowId}`);
}

const flip = (list, item) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

export function toggleProvider(prefs, providerId) {
  return { ...normalize(prefs), hidden: flip(prefs.hidden, providerId) };
}

export function toggleWindow(prefs, providerId, windowId) {
  return { ...normalize(prefs), hiddenWindows: flip(prefs.hiddenWindows, `${providerId}:${windowId}`) };
}

export function toggleShowResetTime(prefs) {
  return { ...normalize(prefs), showResetTime: !prefs.showResetTime };
}

export function toggleShowBars(prefs) {
  return { ...normalize(prefs), showBars: !prefs.showBars };
}

export function toggleShowRemaining(prefs) {
  return { ...normalize(prefs), showRemaining: !prefs.showRemaining };
}

export const isOnBar = (prefs, row) => prefs.sessionOnBar.includes(row);

export function toggleOnBar(prefs, row) {
  return { ...normalize(prefs), sessionOnBar: flip(prefs.sessionOnBar, row) };
}
