<!--
  Users admin page — admin-only.

  Lists every user in the active workspace with their role + status.
  Inline actions:
    • Change role         — dropdown that PUTs the new role.
    • Disable / enable    — toggles status (delete = disable here).
    • Reset password      — opens a small dialog, set a new value.
    • New user            — toolbar button → invite dialog.

  Last-admin protection lives on the server; the UI surfaces the 403
  via a Quasar Notify toast rather than pre-disabling the controls,
  because the "is this the last admin" check is a server-truth.
-->

<template>
  <div class="page q-pa-md">
    <div class="page-header row items-center q-mb-md">
      <div class="col">
        <div class="text-h6">Users</div>
        <div class="text-caption text-grey-7">
          Manage members of your workspace.
        </div>
      </div>
      <div class="col-auto">
        <q-btn
          color="primary"
          icon="person_add"
          label="New user"
          unelevated
          @click="openCreateDialog"
        />
      </div>
    </div>

    <q-table
      :rows="users"
      :columns="columns"
      row-key="id"
      flat bordered
      :loading="loading"
      :pagination="{ rowsPerPage: 0 }"
      hide-bottom
    >
      <template #body-cell-role="props">
        <q-td :props="props">
          <q-select
            v-model="props.row.role"
            :options="roleOptions"
            dense outlined
            emit-value map-options
            style="min-width: 100px"
            @update:model-value="(v) => onRoleChange(props.row, v)"
          />
        </q-td>
      </template>

      <template #body-cell-status="props">
        <q-td :props="props">
          <q-badge
            :color="props.row.status === 'active' ? 'positive' : 'grey-6'"
            :label="props.row.status"
          />
        </q-td>
      </template>

      <template #body-cell-actions="props">
        <q-td :props="props" class="text-right">
          <q-btn
            dense flat
            icon="key"
            @click="openPasswordDialog(props.row)"
          >
            <q-tooltip>Reset password</q-tooltip>
          </q-btn>
          <q-btn
            v-if="props.row.status === 'active'"
            dense flat
            icon="block"
            color="negative"
            @click="onDisable(props.row)"
          >
            <q-tooltip>Disable</q-tooltip>
          </q-btn>
          <q-btn
            v-else
            dense flat
            icon="check_circle"
            color="positive"
            @click="onEnable(props.row)"
          >
            <q-tooltip>Re-enable</q-tooltip>
          </q-btn>
        </q-td>
      </template>
    </q-table>

    <!-- New user dialog -->
    <q-dialog v-model="createOpen">
      <q-card style="min-width: 380px">
        <q-card-section>
          <div class="text-subtitle1">Create user</div>
        </q-card-section>
        <q-card-section class="q-gutter-md">
          <q-input v-model="newUser.email" label="Email" type="email" outlined />
          <q-input v-model="newUser.password" label="Password (min 8 chars)" type="password" outlined />
          <q-input v-model="newUser.displayName" label="Display name (optional)" outlined />
          <q-select
            v-model="newUser.role"
            :options="roleOptions"
            label="Role"
            outlined emit-value map-options
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn unelevated color="primary" label="Create" :loading="creating" @click="onCreate" />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <!-- Password reset dialog -->
    <q-dialog v-model="passwordOpen">
      <q-card style="min-width: 380px">
        <q-card-section>
          <div class="text-subtitle1">Reset password</div>
          <div class="text-caption text-grey-7">
            for {{ passwordTarget?.email }}
          </div>
        </q-card-section>
        <q-card-section>
          <q-input
            v-model="newPassword"
            type="password"
            label="New password (min 8 chars)"
            outlined
            autofocus
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="Cancel" v-close-popup />
          <q-btn
            unelevated color="primary" label="Set password"
            :loading="settingPassword"
            @click="onSetPassword"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useQuasar } from "quasar";
import { Users } from "../api/client.js";

const $q = useQuasar();

const users   = ref([]);
const loading = ref(false);

const roleOptions = [
  { label: "admin",  value: "admin"  },
  { label: "editor", value: "editor" },
  { label: "viewer", value: "viewer" },
];

const columns = [
  { name: "email",       label: "Email",       field: "email",        align: "left", sortable: true },
  { name: "display_name",label: "Name",        field: "display_name", align: "left" },
  { name: "role",        label: "Role",        field: "role",         align: "left" },
  { name: "status",      label: "Status",      field: "status",       align: "left" },
  { name: "last_login_at", label: "Last login", field: r => r.last_login_at ? new Date(r.last_login_at).toLocaleString() : "—", align: "left" },
  { name: "actions",     label: "",            field: "id",           align: "right" },
];

async function load() {
  loading.value = true;
  try {
    users.value = await Users.list();
  } catch (e) {
    notifyError(e, "Failed to load users");
  } finally {
    loading.value = false;
  }
}
onMounted(load);

// ── Role change ───────────────────────────────────────────────────
async function onRoleChange(row, newRole) {
  if (newRole === row._lastRole) return;        // q-select fires on init
  try {
    await Users.update(row.id, { role: newRole });
    $q.notify({ type: "positive", message: `Role updated to ${newRole}` });
    row._lastRole = newRole;
  } catch (e) {
    // Roll back the optimistic update.
    row.role = row._lastRole || row.role;
    notifyError(e, "Failed to update role");
  }
}

// ── Disable / enable ──────────────────────────────────────────────
async function onDisable(row) {
  $q.dialog({
    title: "Disable user",
    message: `Disable ${row.email}? They'll be signed out immediately.`,
    cancel: true,
    persistent: true,
  }).onOk(async () => {
    try {
      await Users.disable(row.id);
      row.status = "disabled";
      $q.notify({ type: "positive", message: "User disabled" });
    } catch (e) {
      notifyError(e, "Failed to disable");
    }
  });
}

async function onEnable(row) {
  try {
    await Users.update(row.id, { status: "active" });
    row.status = "active";
    $q.notify({ type: "positive", message: "User re-enabled" });
  } catch (e) {
    notifyError(e, "Failed to enable");
  }
}

// ── Create ────────────────────────────────────────────────────────
const createOpen = ref(false);
const creating   = ref(false);
const newUser = ref({ email: "", password: "", displayName: "", role: "editor" });

function openCreateDialog() {
  newUser.value = { email: "", password: "", displayName: "", role: "editor" };
  createOpen.value = true;
}
async function onCreate() {
  creating.value = true;
  try {
    await Users.create({
      email:        newUser.value.email,
      password:     newUser.value.password,
      role:         newUser.value.role,
      displayName:  newUser.value.displayName || null,
    });
    $q.notify({ type: "positive", message: "User created" });
    createOpen.value = false;
    await load();
  } catch (e) {
    notifyError(e, "Failed to create user");
  } finally {
    creating.value = false;
  }
}

// ── Password reset ────────────────────────────────────────────────
const passwordOpen     = ref(false);
const settingPassword  = ref(false);
const passwordTarget   = ref(null);
const newPassword      = ref("");

function openPasswordDialog(row) {
  passwordTarget.value = row;
  newPassword.value    = "";
  passwordOpen.value   = true;
}
async function onSetPassword() {
  settingPassword.value = true;
  try {
    await Users.setPassword(passwordTarget.value.id, newPassword.value);
    $q.notify({ type: "positive", message: "Password reset; user must sign in again" });
    passwordOpen.value = false;
  } catch (e) {
    notifyError(e, "Failed to reset password");
  } finally {
    settingPassword.value = false;
  }
}

// ──────────────────────────────────────────────────────────────────
function notifyError(e, fallback) {
  const msg = e?.response?.data?.message || e.message || fallback;
  $q.notify({ type: "negative", message: msg, timeout: 4000 });
}
</script>

<style scoped>
.page {
  max-width: 1100px;
  margin: 0 auto;
}
</style>
