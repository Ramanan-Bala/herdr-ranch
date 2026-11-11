// Agents whose usage their CLI cannot report, so Ranch can only point at it.
// Each entry: { id, name, icon (appHome icons/), bin (looked up on PATH), url }.
// Shown in the hover panel's "Not reported by its CLI" section when bin is installed.
// OpenCode Go was here until `opencode api GET /api/experimental/usage/limits`
// started reporting its limits; it has a provider (providers/opencode.js) now.
export const UNREPORTED = [];
