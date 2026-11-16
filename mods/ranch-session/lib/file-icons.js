// Icon and language metadata for Ranch files (the files pane and the top bar
// file tab). Pure lookup tables, no imports, so it is copied into every mod and
// Node tests can import it; colours are theme token names the
// UI resolves later. The SVGs live in mods/ranch-files/icons/.

/**
 * Exact base names (lowercase) -> [icon, colour].
 * @type {Map<string, [string, string]>}
 */
export const fileExactIcons = new Map([
  ["package.json", ["package", "ansi2"]],
  ...["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "cargo.lock",
    "composer.lock", "gemfile.lock", "poetry.lock", "go.sum"].map((n) => [n, ["lock", "dim"]]),
  ...["tsconfig.json", "jsconfig.json"].map((n) => [n, ["settings", "ansi4"]]),
  ...["dockerfile", "containerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yaml"]
    .map((n) => [n, ["container", "ansi4"]]),
  ...["makefile", "justfile", "cmakelists.txt"].map((n) => [n, ["wrench", "muted"]]),
  ...["license", "license.md", "license.txt", "copying"].map((n) => [n, ["scale", "ansi3"]]),
  ...["readme", "readme.md"].map((n) => [n, ["book-open", "ansi4"]]),
  ...[".gitignore", ".gitattributes", ".gitmodules", ".gitkeep"].map((n) => [n, ["git-branch", "ansi1"]]),
  [".env", ["key-round", "ansi3"]],
  ...[".editorconfig", ".prettierrc", ".eslintrc", ".npmrc", ".nvmrc"]
    .map((n) => [n, ["settings", "muted"]]),
]);

// [icon, colour, "space separated extensions"]
const extensionGroups = [
  ["file-code", "ansi4", "ts tsx mts cts py pyi c h cpp cc cxx hpp hh lua"],
  ["file-code", "ansi3", "js jsx mjs cjs zig"],
  ["file-code", "ansi1", "rs rb java scala swift"],
  ["file-code", "ansi6", "go dart"],
  ["file-code", "ansi5", "kt kts cs fs php ex exs erl hs"],
  ["braces", "ansi3", "json jsonc json5"],
  ["code-xml", "ansi1", "html htm xml xaml plist svelte"],
  ["code-xml", "ansi2", "vue"],
  ["code-xml", "ansi5", "astro"],
  ["palette", "ansi5", "css scss sass less"],
  ["file-text", "ansi4", "md mdx markdown"],
  ["file-text", "muted", "txt rst log"],
  ["file-text", "ansi1", "pdf"],
  ["settings", "ansi5", "yaml yml toml ini conf cfg properties"],
  ["terminal", "ansi2", "sh bash zsh fish ps1 bat cmd"],
  ["database", "ansi6", "sql db sqlite prisma graphql gql"],
  ["image", "ansi5", "png jpg jpeg gif webp ico bmp avif"],
  ["image", "ansi3", "svg"],
  ["film", "ansi5", "mp4 mov webm mkv"],
  ["music", "ansi5", "mp3 wav flac ogg"],
  ["archive", "dim", "zip tar gz tgz bz2 xz 7z rar jar"],
  ["type", "dim", "ttf otf woff woff2"],
];

/**
 * Extension (lowercase, no dot) -> [icon, colour].
 * @type {Map<string, [string, string]>}
 */
export const fileExtensionIcons = new Map(
  extensionGroups.flatMap(([icon, color, exts]) => exts.split(" ").map((ext) => [ext, [icon, color]])),
);

const folderGroups = [
  ["folder-git", "ansi1", ".git .github .gitlab .husky"],
  ["folder-code", "ansi4", "src lib app source pkg internal cmd"],
  ["folder-check", "ansi2", "test tests __tests__ spec specs e2e fixtures"],
  ["folder-pen", "ansi6", "docs doc documentation"],
  ["folder-archive", "dim", "node_modules vendor .venv venv target dist build out .next .nuxt coverage .cache"],
  ["folder-cog", "ansi5", "config .config .vscode .idea settings .claude .codex .opencode"],
  ["folder-heart", "ansi3", "assets public static images img icons media fonts"],
  ["folder-dot", "ansi2", "scripts bin tools"],
];

/**
 * Folder base name (lowercase) -> [icon, colour].
 * @type {Map<string, [string, string]>}
 */
export const folderIcons = new Map(
  folderGroups.flatMap(([icon, color, names]) => names.split(" ").map((name) => [name, [icon, color]])),
);

const asIcon = ([icon, color]) => ({ icon, color });

// Extension of a base name (no dot), or "" when there is none (".env" has none).
function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Icon and theme colour for a file base name, e.g. "main.ts".
 * Exact names win, then special patterns, then the extension, then the default.
 * @param {string} name file base name
 * @returns {{icon: string, color: string}}
 */
export function fileIcon(name) {
  const lower = name.toLowerCase();
  if (fileExactIcons.has(lower)) return asIcon(fileExactIcons.get(lower));
  if (lower.includes(".test.") || lower.includes(".spec.")) return { icon: "flask-conical", color: "ansi2" };
  if (lower.startsWith(".env.")) return { icon: "key-round", color: "ansi3" };
  if (/\.config\.[a-z]+$/.test(lower) || (lower.startsWith(".") && lower.endsWith("rc"))) {
    return { icon: "settings", color: "muted" };
  }
  const ext = extensionOf(lower);
  if (ext === "lock") return { icon: "lock", color: "dim" };
  if (fileExtensionIcons.has(ext)) return asIcon(fileExtensionIcons.get(ext));
  return { icon: "file", color: "muted" };
}

/**
 * Icon and theme colour for a folder base name; `open` swaps the generic
 * folder for its open variant.
 * @param {string} name folder base name
 * @param {boolean} [open]
 * @returns {{icon: string, color: string}}
 */
export function folderIcon(name, open = false) {
  const known = folderIcons.get(name.toLowerCase());
  if (known) return asIcon(known);
  return { icon: open ? "folder-open" : "folder", color: "muted" };
}

// Whole base names (lowercase) Herdr's code viewer knows by name.
const wholeNameLanguages = new Map([
  ["dockerfile", "dockerfile"],
  ["containerfile", "dockerfile"],
  ["makefile", "makefile"],
  [".bashrc", "bash"],
  [".zshrc", "bash"],
  [".profile", "bash"],
  [".zprofile", "bash"],
]);

const languageAliases = new Map([
  ...["mjs", "cjs", "jsx"].map((ext) => [ext, "js"]),
  ...["mts", "cts"].map((ext) => [ext, "ts"]),
  ["yml", "yaml"],
  ...["jsonc", "json5"].map((ext) => [ext, "json"]),
  ...["zsh", "fish", "sh"].map((ext) => [ext, "bash"]),
  ["mdx", "md"],
  ["markdown", "md"],
  ["htm", "html"],
  ...["svelte", "vue", "astro"].map((ext) => [ext, "html"]),
  ["h", "c"],
  ...["hpp", "hh", "cc", "cxx"].map((ext) => [ext, "cpp"]),
  ["kts", "kt"],
  ["tf", "hcl"],
]);

/**
 * Herdr code-viewer language token for a file path (anything after the last
 * slash is the base name). Unknown extensions return themselves; nameless
 * files return "txt".
 * @param {string} path
 * @returns {string}
 */
export function languageFor(path) {
  const name = path.split(/[\\/]/).pop().toLowerCase();
  if (wholeNameLanguages.has(name)) return wholeNameLanguages.get(name);
  if (name === ".env" || name.startsWith(".env.")) return "bash";
  const ext = extensionOf(name);
  if (!ext) return "txt";
  return languageAliases.get(ext) ?? ext;
}

/**
 * Relative path of an icon's SVG.
 * @param {string} icon icon base name, e.g. "file-code"
 * @returns {string}
 */
export function iconPath(icon) {
  return `mods/ranch-files/icons/${icon}.svg`;
}
