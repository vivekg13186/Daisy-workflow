import { createWebHistory, createRouter } from "vue-router";

import HomePage from "./pages/HomePage.vue";
import FlowDesigner from "./pages/FlowDesigner.vue";
import FlowInspector from "./pages/FlowInspector.vue";
import InstanceViewer from "./pages/InstanceViewer.vue";
import TriggerDesigner from "./pages/TriggerDesigner.vue";
import ConfigDesigner from "./pages/ConfigDesigner.vue";

const routes = [
  { path: "/", component: HomePage },
  { path: "/flowDesigner/:id", component: FlowDesigner },
  { path: "/triggerDesigner/:id", component: TriggerDesigner },
  { path: "/configDesigner/:id", component: ConfigDesigner, name: "configDesigner" },
  { path: "/flowInspector", component: FlowInspector, name: "flowInspector" },
  { path: "/instanceViewer/:id", component: InstanceViewer, name: "instanceViewer" },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});