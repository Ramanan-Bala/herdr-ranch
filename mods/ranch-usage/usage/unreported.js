// Agents whose usage their CLI cannot report, so Ranch can only point at it.
// Each entry: { id, name, icon (appHome icons/), bin (looked up on PATH), url }.
// Shown in the hover panel's "Not reported by its CLI" section when bin is installed.
export const UNREPORTED = [
  { id: "opencode", name: "OpenCode Go", icon: "icons/opencode.svg", bin: "opencode", url: "https://opencode.ai/auth" },
];
