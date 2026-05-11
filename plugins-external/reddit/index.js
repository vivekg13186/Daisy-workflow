// reddit.search — example external plugin (SDK-driven version).
//
// The four-endpoint HTTP contract (/manifest, /healthz, /readyz,
// /execute) is wired by @daisy-dag/plugin-sdk. Authors only need
// to write execute() + an optional readyz() probe.
//
// Compare against the pre-SDK version: ~25 lines vs ~170.

import { servePlugin } from "@daisy-dag/plugin-sdk";
import fs from "node:fs";

const manifest = JSON.parse(
  fs.readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
);

const USER_AGENT = process.env.REDDIT_USER_AGENT || "daisy-dag-example/0.1.0";

servePlugin({
  manifest,
  async execute(input, ctx) {
    const query     = String(input.query || "").trim();
    if (!query) throw new Error("input.query is required");
    const subreddit = input.subreddit ? String(input.subreddit).trim() : null;
    const limit     = Math.max(1, Math.min(parseInt(input.limit, 10) || 10, 100));
    const sort      = ["relevance","hot","top","new","comments"].includes(input.sort)
                      ? input.sort : "relevance";

    const params = new URLSearchParams({ q: query, sort, limit: String(limit) });
    const path   = subreddit
      ? `/r/${encodeURIComponent(subreddit)}/search.json?${params}&restrict_sr=on`
      : `/search.json?${params}`;

    const r = await fetch(`https://www.reddit.com${path}`, {
      headers: { "user-agent": USER_AGENT, "accept": "application/json" },
      signal:  ctx.signal,           // honour the engine's deadline / cancel
    });
    if (!r.ok) {
      const text = (await r.text().catch(() => "")).slice(0, 200);
      throw new Error(`reddit api returned HTTP ${r.status}: ${text}`);
    }
    const children = (await r.json())?.data?.children || [];
    const posts = children.map((c) => {
      const d = c?.data || {};
      return {
        id:         d.id || null,
        title:      d.title || "",
        url:        d.url || null,
        permalink:  d.permalink ? `https://www.reddit.com${d.permalink}` : null,
        subreddit:  d.subreddit || null,
        score:      typeof d.score        === "number" ? d.score        : 0,
        comments:   typeof d.num_comments === "number" ? d.num_comments : 0,
        createdUtc: typeof d.created_utc  === "number" ? Math.floor(d.created_utc) : null,
      };
    });
    return { posts, count: posts.length };
  },

  // Tiny outbound probe — confirms the plugin can reach Reddit.
  // Bounded to 2s so the engine's healthcheck loop doesn't stall
  // on a slow upstream.
  async readyz() {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 2000);
    if (typeof t.unref === "function") t.unref();
    try {
      const r = await fetch("https://www.reddit.com/r/popular.json?limit=1", {
        headers: { "user-agent": USER_AGENT },
        signal:  ac.signal,
      });
      return r.ok;
    } catch { return false; }
    finally  { clearTimeout(t); }
  },
});
