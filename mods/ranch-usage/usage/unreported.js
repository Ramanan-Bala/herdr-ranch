// Agents whose usage their CLI cannot report, so Ranch can only point at it.
// Each entry: { id, name, icon (appHome icons/), bin (looked up on PATH), url }.
// Shown in the hover panel's "Not reported by its CLI" section when bin is installed.
// OpenCode Go and Antigravity were here until their CLIs started reporting
// limits; both have providers (providers/opencode.js, providers/antigravity.js) now.
/** @type {Array<{ id: string, name: string, icon: string, bin: string, url: string }>} */
export const UNREPORTED = [];
