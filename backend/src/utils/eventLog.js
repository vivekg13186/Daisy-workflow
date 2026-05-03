// Append-only JSONL logger for engine events.
//
// Each event is one JSON object per line — easy to grep, tail, or pipe to a
// log shipper. Multiple workers can write to the same file safely because
// we open with O_APPEND (atomic on POSIX) and each write is one syscall.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.resolve(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "node-events.log");

let stream = null;

function ensureStream() {
  if (stream) return stream;
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
  stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  stream.on("error", (e) => log.error("event log stream error", { error: e.message }));
  return stream;
}

/**
 * Append a node event as one JSON line.
 * @param {object} evt — should include at least { executionId, node, status, at }
 */
export function logNodeEvent(evt) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...evt }) + "\n";
    ensureStream().write(line);
  } catch (e) {
    // Don't let logging failures crash the worker.
    log.warn("logNodeEvent failed", { error: e.message });
  }
}

export const NODE_EVENT_LOG_PATH = LOG_FILE;
