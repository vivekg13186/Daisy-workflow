// Theme store — light / dark, persisted in localStorage.
//
// Same pattern as stores/auth.js: plain Vue reactive(), no Pinia.
// CSS variables for the dark palette live in src/styles.css and are
// gated on `html[data-theme="dark"]`. Quasar's own components are
// switched via `$q.dark.set(...)` at toggle time (done from
// components/UserMenu.vue once Quasar is mounted).

import { reactive, watchEffect } from "vue";

const STORAGE_KEY = "daisy.theme";

function detectInitial() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
  } catch { /* localStorage disabled */ }
  // Fall back to the OS preference.
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

export const theme = reactive({
  mode: detectInitial(),

  /** Flip light ↔ dark. */
  toggle() {
    this.mode = this.mode === "dark" ? "light" : "dark";
  },

  /** Set explicitly. */
  set(mode) {
    if (mode !== "dark" && mode !== "light") return;
    this.mode = mode;
  },
});

// Mirror state → <html data-theme="…"> + localStorage. Vue's
// watchEffect picks up changes to `theme.mode` automatically.
watchEffect(() => {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", theme.mode);
  }
  try { localStorage.setItem(STORAGE_KEY, theme.mode); }
  catch { /* ignore */ }
});
