// Shared helpers for file / csv / excel plugins.
// Lives outside src/plugins/builtin/ so the auto-loader skips it.

import path from "node:path";
import { config } from "../../config.js";

/**
 * Resolve a user-supplied path safely.
 *   - With FILE_ROOT set: relative paths join it; absolute paths are accepted
 *     only if they're already inside the root. Anything else throws.
 *   - Without FILE_ROOT set: relative paths resolve against process.cwd().
 *
 * Always returns an absolute, normalized path.
 */
export function resolveSafePath(p) {
  if (typeof p !== "string" || !p.length) {
    throw new Error("path required");
  }
  const root = config.fileRoot && path.resolve(config.fileRoot);
  if (!root) {
    return path.resolve(p);
  }
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path "${p}" escapes FILE_ROOT (${root})`);
  }
  return abs;
}

/** A simple `*.ext`-style glob to RegExp. Anchors at start AND end of name. */
export function globToRegExp(pattern) {
  if (!pattern) return null;
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}
