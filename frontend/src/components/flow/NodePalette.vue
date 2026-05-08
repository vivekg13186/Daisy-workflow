<!--
  Left palette in the canvas tab. Lists every registered action plugin grouped
  by prefix (the part before the first '.'). Clicking emits "add" so the parent
  drops a new node onto the canvas.
-->
<template>
  <div class="palette column no-wrap full-height">
    <div class="q-pa-sm">
      <q-input v-model="filter" rounded dense  outlined placeholder="Filter…" class="q-pa-xs">
        <template v-slot:prepend><q-icon name="search" size="16px" /></template>
      </q-input>
    </div>


    <q-list dense bordered separator class="col scroll" style="border: 0;">
      <q-expansion-item v-for="g in groups" :key="g.prefix" dense dense-toggle default-opened :label="g.prefix"
         header-class="bg-grey-11">
        <q-item v-for="p in g.items" :key="p.name" clickable dense @click="$emit('add', p)" v-ripple>
          <q-item-section>
            <q-item-label>{{ p.name }}</q-item-label>
            
          </q-item-section>
          <q-item-section side>
            <q-icon name="add" size="16px" />
          </q-item-section>
        </q-item>
      </q-expansion-item>
      <div v-if="groups.length === 0" class="q-pa-md text-caption text-grey text-center">
        No matching plugins.
      </div>
    </q-list>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";

const props = defineProps({
  plugins: { type: Array, default: () => [] },
});
defineEmits(["add"]);

const filter = ref("");

const groups = computed(() => {
  const f = filter.value.trim().toLowerCase();
  const filtered = props.plugins.filter(p =>
    !f || p.name.toLowerCase().includes(f) || (p.description || "").toLowerCase().includes(f)
  );
  const byPrefix = new Map();
  for (const p of filtered) {
    const prefix = p.name.includes(".") ? p.name.split(".")[0] : "core";
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(p);
  }
  return [...byPrefix.entries()]
    .map(([prefix, items]) => ({ prefix, items: items.sort((a, b) => a.name.localeCompare(b.name)) }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
});
</script>

<style scoped></style>
