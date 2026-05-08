<template>
  <q-table
    v-model:selected="selected"
    :rows="filteredRows"
    :columns="columns"
    :title="title"
    row-key="id"
    flat
    dense
    bordered
    selection="multiple"
  >
    <template v-slot:top-right>
      <q-input
        v-model="filter"
        borderless
        dense
        debounce="300"
        placeholder="Search"
        class="q-mr-sm"
      >
        <template v-slot:append>
          <q-icon name="search" />
        </template>
      </q-input>

      <q-btn icon="add" flat dense @click="onAdd">
        <q-tooltip>Add new item</q-tooltip>
      </q-btn>

      <q-btn
        icon="delete"
        flat
        dense
        :disable="selected.length === 0"
        @click="onDeleteSelected"
      >
        <q-tooltip>Delete selected</q-tooltip>
      </q-btn>
    </template>

    <!-- Name Column -->
    <template v-slot:body-cell-name="props">
      <q-td :props="props">
        <span class="text-primary cursor-pointer" @click="onEdit(props.row)">
          {{ props.row.name }}
        </span>
      </q-td>
    </template>

    <!-- Actions Column -->
    <template v-slot:body-cell-actions="props">
      <q-td :props="props" auto-width>
        <q-btn
          icon="edit"
          flat
          round
          dense
          size="sm"
          @click="onEdit(props.row)"
        >
          <q-tooltip>Edit</q-tooltip>
        </q-btn>

        <q-btn
          icon="delete"
          flat
          round
          dense
          size="sm"
          color="negative"
          @click="onDelete(props.row)"
        >
          <q-tooltip>Delete</q-tooltip>
        </q-btn>
      </q-td>
    </template>
  </q-table>
</template>

<script setup>
  import { computed, ref ,watch} from "vue";

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
