<!--
  Floating user-badge widget — top-right of every authenticated page.

  Layout choice: the visible footprint is just a single 30x30 avatar
  button. Clicking opens the full menu (email, role, workspace list,
  admin links, sign out). Keeping it small avoids overlapping the
  per-page q-toolbar buttons that live in the same corner.

  Hidden on /login and other public routes.
-->

<template>
  <div v-if="visible" class="user-menu">
    <q-btn round flat dense class="user-btn" no-caps>
      <q-avatar size="30px" color="primary" text-color="white">
        {{ initials }}
      </q-avatar>

      <q-menu anchor="bottom right" self="top right">
        <q-list dense style="min-width: 240px">
          <q-item-label header class="text-caption">Signed in as</q-item-label>
          <q-item>
            <q-item-section>
              <q-item-label>{{ auth.user.email }}</q-item-label>
              <q-item-label caption>role: {{ auth.user.role }}</q-item-label>
            </q-item-section>
          </q-item>

          <q-separator />

          <q-item v-if="workspaces.length <= 1">
            <q-item-section>
              <q-item-label caption>Workspace</q-item-label>
              <q-item-label>{{ activeWorkspaceName || "—" }}</q-item-label>
            </q-item-section>
          </q-item>
          <q-expansion-item
            v-else
            dense
            icon="workspaces"
            :label="`Workspace: ${activeWorkspaceName}`"
            class="text-body2"
          >
            <q-list dense>
              <q-item
                v-for="w in workspaces"
                :key="w.id"
                clickable
                v-close-popup
                :active="w.id === auth.user.workspaceId"
                @click="onSwitchWorkspace(w)"
              >
                <q-item-section>
                  <q-item-label>{{ w.name }}</q-item-label>
                  <q-item-label caption>role: {{ w.role }}</q-item-label>
                </q-item-section>
                <q-item-section v-if="w.id === auth.user.workspaceId" side>
                  <q-icon name="check" color="primary" />
                </q-item-section>
              </q-item>
            </q-list>
          </q-expansion-item>

          <q-separator />

          <q-item clickable v-close-popup @click="goWorkspace">
            <q-item-section avatar><q-icon name="settings" /></q-item-section>
            <q-item-section>Workspace settings</q-item-section>
          </q-item>
          <q-item v-if="auth.user.role === 'admin'" clickable v-close-popup @click="goUsers">
            <q-item-section avatar><q-icon name="people" /></q-item-section>
            <q-item-section>Users</q-item-section>
          </q-item>
          <q-item v-if="auth.user.role === 'admin'" clickable v-close-popup @click="goAudit">
            <q-item-section avatar><q-icon name="history" /></q-item-section>
            <q-item-section>Audit log</q-item-section>
          </q-item>
          <q-item v-if="auth.user.role === 'admin'" clickable v-close-popup @click="goPlugins">
            <q-item-section avatar><q-icon name="extension" /></q-item-section>
            <q-item-section>Plugins</q-item-section>
          </q-item>

          <q-separator />

          <q-item clickable v-close-popup @click="onLogout">
            <q-item-section avatar><q-icon name="logout" /></q-item-section>
            <q-item-section>Sign out</q-item-section>
          </q-item>
        </q-list>
      </q-menu>
    </q-btn>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { auth } from "../stores/auth.js";
import { Workspaces } from "../api/client.js";

const route  = useRoute();
const router = useRouter();

const workspaces = ref([]);

const visible = computed(() => {
  if (route.meta?.public) return false;
  return auth.isAuthenticated;
});

const initials = computed(() => {
  const e = auth.user?.email || "";
  const local = e.split("@")[0] || "?";
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (local.slice(0, 2) || "?").toUpperCase();
});

const activeWorkspaceName = computed(() => {
  return workspaces.value.find(w => w.id === auth.user?.workspaceId)?.name || null;
});

async function loadWorkspaces() {
  try {
    const data = await Workspaces.list();
    workspaces.value = data.workspaces || [];
  } catch {
    workspaces.value = [];
  }
}

onMounted(() => { if (auth.isAuthenticated) loadWorkspaces(); });
watch(() => auth.user?.id, (id) => { if (id) loadWorkspaces(); else workspaces.value = []; });

async function onSwitchWorkspace(w) {
  if (w.id === auth.user.workspaceId) return;
  try {
    const { accessToken, user } = await Workspaces.switch(w.id);
    auth.token = accessToken;
    auth.user  = user;
    router.go(0);
  } catch { /* notify already happens via the global axios handler */ }
}

function goUsers()      { router.push({ name: "users" }); }
function goAudit()      { router.push({ name: "audit" }); }
function goPlugins()    { router.push({ name: "plugins" }); }
function goWorkspace()  { router.push({ name: "workspace" }); }

async function onLogout() {
  await auth.logout();
  router.replace({ name: "login" });
}
</script>

<style scoped>
/*
  Compact floating avatar — 36x36 button, 30x30 avatar inside.
  Sits over the top-right corner. Pages with a q-toolbar receive a
  paired global padding rule (see App.vue) so the toolbar's right-most
  control stops short of the avatar's footprint.
*/
.user-menu {
  position: fixed;
  top: 6px;
  right: 8px;
  z-index: 9000;
}
.user-btn {
  width: 36px;
  height: 36px;
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 50%;
  padding: 0;
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
}
.user-btn:hover {
  box-shadow: 0 2px 6px rgba(15, 23, 42, 0.14);
}
</style>
