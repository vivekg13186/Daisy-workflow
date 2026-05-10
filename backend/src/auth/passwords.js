// Password hashing helpers.
//
// We use bcryptjs (pure-JS, no native build step) at cost factor 11.
// Hash time on a modern laptop is ~120ms which is the right ballpark
// for "annoying enough to thwart offline cracking, fast enough that
// users don't notice on login".
//
// If you ever decide to swap in argon2id for stronger memory-hardness,
// the only change required is here — every consumer goes through
// hash() / verify().
//
// Strength rationale:
//   • Cost 10 ≈  60ms,  cost 11 ≈ 120ms,  cost 12 ≈ 250ms.
//   • OWASP 2024 baseline = 10. We pick 11 to give a margin without
//     visibly slowing the login screen.
//   • Bumping later is safe — old hashes still verify under their
//     embedded cost factor, and we can lazily upgrade on next login
//     (see needsRehash below).

import bcrypt from "bcryptjs";

const COST = 11;

/** Hash a plaintext password. Returns a self-describing bcrypt string
 *  (salt + cost + digest) ~60 chars. */
export async function hash(plaintext) {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("hash: plaintext required");
  }
  if (plaintext.length > 1000) {
    // Truncate-or-throw decision: bcrypt silently truncates at 72
    // bytes and we don't want that surprise. Reject anything
    // ridiculously long instead.
    throw new Error("hash: password too long (max 1000 chars)");
  }
  return await bcrypt.hash(plaintext, COST);
}

/** Verify a plaintext against a stored hash. Resistant to timing
 *  attacks via bcrypt's constant-time compare. */
export async function verify(plaintext, storedHash) {
  if (!storedHash) return false;
  try {
    return await bcrypt.compare(plaintext, storedHash);
  } catch {
    // Malformed hash or non-bcrypt format → treat as mismatch rather
    // than 500'ing the login endpoint.
    return false;
  }
}

/** True if a stored hash should be re-hashed at the next successful
 *  login (we bumped COST since it was created). Caller does this
 *  opportunistically — it's a no-op for fresh hashes. */
export function needsRehash(storedHash) {
  if (typeof storedHash !== "string") return false;
  // bcrypt format: $2a$<cost>$...
  const m = storedHash.match(/^\$2[aby]\$(\d{2})\$/);
  if (!m) return false;
  return parseInt(m[1], 10) < COST;
}
