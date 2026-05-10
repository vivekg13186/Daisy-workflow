<!--
  Workspace settings — admin can rename the active workspace and view
  member roster. The roster is read-only here; user-level changes
  (role, status, password) live on /users.
-->

<template>
  <div class="page q-pa-md">
    <div class="page-header q-mb-md">
      <div class="text-h6">Workspace</div>
      <div class="text-caption text-grey-7">Settings and member roster.</div>
    </div>

    <q-card flat bordered class="q-pa-md q-mb-md">
      <div class="row items-end q-gutter-md">
        <q-input
          v-model="form.name"
          label="Workspace name"
          outlined
          dense
          class="col"
        />
        <q-btn
          color="primary"
          unelevated
          label="Save"
          :disable="!isAdmin || !form.name?.trim() || form.name === ws?.name"
          :loading="saving"
          @click="onSave"
        />
      </div>
      <div v-if="ws" class="text-caption text-grey-7 q-mt-sm">
        slug: <code>{{ ws.slug }}</code> · created
        {{ ws.created_at ? new Date(ws.created_at).toLocaleDateString() : "—" }}
      </div>
    </q-card>

    <q-card flat bordered>
      <q-card-section>
        <div class="text-subtitle2">Members</div>
      </q-card-section>
      <q-table
        :rows="members"
        :columns="memberColumns"
        row-key="id"
        flat
        :pagination="{ rowsPerPage: 0 }"
        hide-bottom
        :loading="loading"
      >
        <template #body-cell-status="props">
          <q-td :props="props">
            <q-badge
              :color="props.row.status === 'active' ? 'positive' : 'grey-6'"
              :label="props.row.status"
            />
          </q-td>
        </template>
        <template #body-cell-primary="props">
          <q-td :props="props">
            <q-icon v-if="props.row.primary" name="star" color="amber-7" size="18px">
              <q-tooltip>Primary workspace for this user</q-tooltip>
            </q-icon>
          </q-td>
        </template>
      </q-table>
    </q-card>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useQuasar } from "quasar";
import { Workspaces } from "../api/client.js";
import { auth } from "../stores/auth.js";

const $q = useQuasar();

const ws       = ref(null);
const members  = ref([]);
const loading  = ref(false);
const saving   = ref(false);
const form     = ref({ name: "" });

const isAdmin = computed(() => auth.user?.role === "admin");

const memberColumns = [
  { name: "primary",     label: "",        field: "primary",      align: "center" },
  { name: "email",       label: "Email",   field: "email",        align: "left", sortable: true },
  { name: "display_name",label: "Name",    field: "display_name", align: "left" },
  { name: "role",        label: "Role",    field: "role",         align: "left" },
  { name: "status",      label: "Status",  field: "status",       align: "left" },
  { name: "last_login_at", label: "Last login",
    field: r => r.last_login_at ? new Date(r.last_login_at).toLocaleString() : "—",
    align: "left" },
];

async function load() {
  if (!auth.user?.workspaceId) return;
  loading.value = true;
  try {
    ws.value = await Workspaces.get(auth.user.workspaceId);
    form.value.name = ws.value.name;
    if (isAdmin.value) {
      members.value = await Workspaces.members(auth.user.workspaceId);
    }
  } catch (e) {
    notifyError(e, "Failed to load workspace");
  } finally {
    loading.value = false;
  }
}
onMounted(load);

async function onSave() {
  saving.value = true;
  try {
    await Workspaces.rename(ws.value.id, form.value.name.trim());
    ws.value.name = form.value.name.trim();
    $q.notify({ type: "positive", message: "Workspace renamed" });
  } catch (e) {
    notifyError(e, "Failed to rename");
  } finally {
    saving.value = false;
  }
}

function notifyError(e, fallback) {
  const msg = e?.response?.data?.message || e.message || fallback;
  $q.notify({ type: "negative", message: msg, timeout: 4000 });
}
</script>

<style scoped>
.page {
  max-width: 1000px;
  margin: 0 auto;
}
</style>
