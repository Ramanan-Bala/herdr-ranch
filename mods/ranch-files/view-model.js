// Pure helpers for the Ranch files pane: git-mark propagation, breadcrumbs and
// preview limits. No Herdr imports, so Node tests can
// run them.

export const PREVIEW_LIMIT = 400000;

// U/D beat M beats A: a folder dot shows its most severe descendant.
const SEVERITY = { A: 1, M: 2, D: 3, U: 3 };

const normalize = (path) => String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");

/**
 * Git marks keyed by absolute path -> { files, folders }, both Maps. File keys
 * are relative to `root`; folder keys are every ancestor folder of a marked
 * file, holding the most severe mark among its descendants.
 * @param {Record<string, string>} marks absolute path -> "A" | "M" | "D" | "U"
 * @param {string} root
 * @returns {{files: Map<string, string>, folders: Map<string, string>}}
 */
export function treeMarks(marks, root) {
  const files = new Map();
  const folders = new Map();
  const base = normalize(root);
  for (const [abs, mark] of Object.entries(marks ?? {})) {
    const path = normalize(abs);
    if (base ? !path.startsWith(base + "/") : !path.startsWith("/")) continue;
    const rel = base ? path.slice(base.length + 1) : path.slice(1);
    if (!rel) continue;
    files.set(rel, mark);
    const parts = rel.split("/");
    parts.pop();
    let folder = "";
    for (const part of parts) {
      folder = folder ? `${folder}/${part}` : part;
      const old = folders.get(folder);
      if (!old || (SEVERITY[mark] ?? 0) > (SEVERITY[old] ?? 0)) folders.set(folder, mark);
    }
  }
  return { files, folders };
}

/** One path segment per breadcrumb entry, without empty pieces. */
export function breadcrumbs(path) {
  return String(path ?? "").split(/[\\/]/).filter(Boolean);
}

/** Root-relative panel crumbs, or the last four absolute-path crumbs in a pane. */
export function viewerBreadcrumbs(path, root = null) {
  const parts = breadcrumbs(path);
  if (root === null) return parts.length > 4 ? ["…", ...parts.slice(-4)] : parts;
  const base = breadcrumbs(root);
  return [...base.slice(-1), ...parts.slice(base.length)];
}

/** Parent folder of an absolute path; keeps a Windows drive root. */
export function parentPath(path) {
  const p = String(path ?? "");
  let i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  while (i > 0 && (p[i - 1] === "/" || p[i - 1] === "\\")) i--;
  if (i <= 0) return String(path ?? "").startsWith("/") ? "/" : p;
  const parent = p.slice(0, i);
  return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
}

/** The editor text for a file, cut at `cap` with the existing truncation note. */
export function previewText(text, cap = PREVIEW_LIMIT) {
  if (text.length <= cap) return { value: text, truncated: false };
  return { value: text.slice(0, cap) + "\n… (file truncated)", truncated: true };
}

/** Lines in a text, ignoring the empty line after a trailing newline. */
export function lineCount(text) {
  return text ? text.split("\n").length - Number(text.endsWith("\n")) : 0;
}
