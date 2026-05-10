<template>
  <q-table v-model:selected="selected" :rows="filteredRows" :columns="columns" :title="title" row-key="id" flat dense
    bordered selection="multiple">
    <template v-slot:top-right>
      <q-input v-model="filter" borderless dense debounce="300" placeholder="Search" class="q-mr-sm">
        <template v-slot:append>
          <q-icon name="search" size="sm"/>
        </template>
      </q-input>

      <q-btn icon="add" flat dense @click="onAdd" size="sm">
        <q-tooltip>Add new item</q-tooltip>
      </q-btn>

      <q-btn size="sm" icon="delete" flat dense :disable="selected.length === 0" @click="onDeleteSelected">
        <q-tooltip>Delete selected</q-tooltip>
      </q-btn>
    </template>

    <!-- Name column — primary clickable label that opens the row editor.
         Triggers / Workflows / Configurations use `name`; Agents use
         `title`. Both render the same way. Tables that need a different
         primary field can override via the standard `body-cell-<colName>`
         slot from outside (Quasar passes named slots through). -->
    <template v-slot:body-cell-name="props">
      <q-td :props="props">
        <span class="text-primary cursor-pointer" @click="onEdit(props.row)">
          {{ props.row.name }}
        </span>
      </q-td>
    </template>

    <!-- Title column — same link affordance for tables keyed on `title`. -->
    <template v-slot:body-cell-title="props">
      <q-td :props="props">
        <span class="text-primary cursor-pointer" @click="onEdit(props.row)">
          {{ props.row.title }}
        </span>
      </q-td>
    </template>

    <!-- Actions Column -->
    <template v-slot:body-cell-actions="props">
      <q-td :props="props" auto-width>
        <q-btn icon="more_vert" flat size="sm" dense>
          <q-tooltip>Row actions</q-tooltip>
          <q-menu>
            <q-list dense style="min-width: 200px">
              <q-item dense clickable v-close-popup @click="onEdit(props.row)">
                <q-item-section avatar>
                  <q-icon name="edit" size="18px" />
                </q-item-section>
                <q-item-section>Edit</q-item-section>
              </q-item>
              <q-item dense clickable v-close-popup @click="onDelete(props.row)">
                <q-item-section avatar>
                  <q-icon name="delete" size="18px" color="negative" />
                </q-item-section>
                <q-item-section>Delete</q-item-section>
              </q-item>
            </q-list>
          </q-menu>
        </q-btn>
      </q-td>
    </template>
  </q-table>
</template>

<script setup>
import { computed, ref, watch } from "vue";

const props = defineProps({
  rows: {
    type: Array,
    default: () => [],
  },
  columns: {
    type: Array,
    default: () => [],
  },
  title: {
    type: String,
    default: "",
  },
});

const emit = defineEmits([
  "edit",
  "add",
  "delete",
  "delete-selected",
  "selection-change",
]);

const selected = ref([]);
const filter = ref("");

const filteredRows = computed(() => {
  if (!filter.value) return props.rows;

  const search = filter.value.toLowerCase();

  return props.rows.filter((row) =>
    Object.values(row).some((value) =>
      String(value).toLowerCase().includes(search),
    ),
  );
});

function onEdit(row) {
  emit("edit", row);
}

function onAdd() {
  emit("add");
}

function onDelete(row) {
  emit("delete", row);
}

function onDeleteSelected() {
  emit("delete-selected", selected.value);
}

watch(selected, (value) => {
  emit("selection-change", value);
});
</script>
