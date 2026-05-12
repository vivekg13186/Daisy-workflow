import { createApp } from "vue";
import { Quasar, Notify, Dialog } from "quasar";

import "@quasar/extras/material-icons/material-icons.css";
// Import icon libraries
import "@quasar/extras/material-icons/material-icons.css";

// Import Quasar css
import "quasar/src/css/index.sass";

import "@vue-flow/core/dist/style.css";
import "@vue-flow/core/dist/theme-default.css";
import "@vue-flow/controls/dist/style.css";
import "./styles.css";
// Import the theme store at boot — its module-side `watchEffect`
// applies the saved theme to <html data-theme="…"> before any
// component mounts, so the page never flashes the wrong palette.
import { theme } from "./stores/theme.js";
import {router} from "./routes";
import App from "./App.vue";
const routes = createApp(App)
  .use(router)
  .use(Quasar, {
    plugins: { Notify, Dialog },
    // Light + dark both supported. The theme store (stores/theme.js)
    // owns the live mode and persists it in localStorage. The user
    // menu's watcher syncs $q.dark with the store.
    config: {
      dark: theme.mode === "dark",
      brand: {
        primary:   "#2f6df3",
        secondary: "#475569",
        accent:    "#2f6df3",
        positive:  "#16a34a",
        negative:  "#dc2626",
        warning:   "#d97706",
        info:      "#0284c7",
      },
      notify:  { position: "bottom", timeout: 2200 },
    },
  })
  .mount("#app");
