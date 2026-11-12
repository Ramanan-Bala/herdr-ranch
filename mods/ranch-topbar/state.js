// Pure helpers for the Ranch top bar's persisted state (audit finding 12).
// No herdr imports: testable in Node.

/**
 * Parses the remembered per-space side panel ("panels" in localStorage) into
 * a plain space -> panel id map. Anything corrupted — invalid JSON, or a
 * parsed value that is not a plain object, or an entry whose value is not a
 * known panel id string — is dropped, so a broken save can never break the
 * layout controls. `knownIds` is the bar's list of toggleable panel ids.
 * @param {string|null} text raw localStorage value
 * @param {Array<string>} knownIds
 * @returns {Object<string, string|null>}
 */
export function readPanels(text, knownIds) {
  let parsed;
  try {
    parsed = JSON.parse(text ?? "{}");
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out = {};
  for (const [space, id] of Object.entries(parsed)) {
    if (typeof id === "string" && knownIds.includes(id)) out[space] = id;
  }
  return out;
}
