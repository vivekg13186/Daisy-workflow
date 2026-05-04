// Shared SMTP transport cache for the email.send plugin.
//
// Lives outside src/plugins/builtin/ so the auto-loader doesn't try to register
// it as an action.

import nodemailer from "nodemailer";
import { config } from "../../config.js";
import { log } from "../../utils/logger.js";

// Cache transports by their effective settings. Most flows use the same SMTP
// server every time, so this keeps the connection pool warm.
const transports = new Map();

function effectiveOptions(override) {
  const o = override || {};
  return {
    host:   o.host   ?? config.email.host,
    port:   o.port   ?? config.email.port,
    secure: o.secure ?? config.email.secure,
    user:   o.user   ?? config.email.user,
    pass:   o.pass   ?? config.email.pass,
  };
}

function key(opts) {
  return JSON.stringify([opts.host, opts.port, opts.secure, opts.user]);
}

/**
 * Resolve the SMTP transport to use for a single send.
 * Falls back to the JSON dry-run transport when the host is `json` or
 * `dry-run` — nodemailer renders the message but doesn't dispatch.
 */
export function getTransport(override) {
  const opts = effectiveOptions(override);

  if (!opts.host || opts.host === "json" || opts.host === "dry-run") {
    if (!opts.host) {
      log.warn("email: no SMTP host configured, using JSON dry-run transport");
    }
    // Singleton — one shared dry-run transport.
    if (!transports.has("__json__")) {
      transports.set("__json__", nodemailer.createTransport({ jsonTransport: true }));
    }
    return transports.get("__json__");
  }

  const k = key(opts);
  let t = transports.get(k);
  if (!t) {
    t = nodemailer.createTransport({
      host:   opts.host,
      port:   opts.port,
      secure: opts.secure,
      auth:   opts.user ? { user: opts.user, pass: opts.pass } : undefined,
      pool:   true,             // keep TCP connection between sends
      maxConnections: 3,
    });
    transports.set(k, t);
  }
  return t;
}

export function defaultFrom() {
  return config.email.from || config.email.user || "";
}
