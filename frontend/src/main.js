import { createApp } from "vue";
import { createPinia } from "pinia";
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
import {router} from "./routes";
import App from "./App.vue";
const routes = createApp(App)
  .use(router)
  .use(createPinia())
  .use(Quasar, {
    plugins: { Notify, Dialog },
    config: {},
  })
  .mount("#app");
