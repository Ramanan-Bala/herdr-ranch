// One shared answer for Herdr's knownAgents() (which agents are installed). It
// asks the login shell and can take ~30 s, so the top bar, Settings and the
// Start-agent dialog share the result under "ranch.knownAgents" and only one
// copy asks at a time, when the shared answer is older than that caller needs.
// Pure module (herdr functions are passed in) so it can be tested in Node.

export const KNOWN_KEY = "ranch.knownAgents";
export const KNOWN_AT_KEY = "ranch.knownAgents.at"; // ms of the last ask (claimed at start)

/** Background refresh (top bar). */
export const KNOWN_EVERY_MS = 15 * 60_000;
/** Opening Settings re-checks an answer older than this. */
export const KNOWN_ON_SETTINGS_MS = 60_000;
/** Opening the Start-agent dialog re-checks an answer older than this. */
export const KNOWN_ON_LAUNCH_MS = 5 * 60_000;

/** True when no copy has asked within `maxAge` ms (or none is asking). */
export function knownAgentsDue(shared, now, maxAge) {
  const at = shared(KNOWN_AT_KEY);
  return !(typeof at === "number" && Number.isFinite(at) && at > 0 && now - at < maxAge);
}

/**
 * Asks knownAgents() if the shared answer is older than `maxAge`, and shares
 * the result. Returns the new list, or null when it didn't ask. A failed ask
 * releases the claim so the next caller can retry, then rethrows.
 */
export async function refreshKnownAgents({ knownAgents, shared, setShared, maxAge, now = Date.now() }) {
  if (!knownAgentsDue(shared, now, maxAge)) return null;
  setShared(KNOWN_AT_KEY, now);
  try {
    const list = await knownAgents();
    setShared(KNOWN_KEY, list);
    return list;
  } catch (err) {
    setShared(KNOWN_AT_KEY, 0);
    throw err;
  }
}
