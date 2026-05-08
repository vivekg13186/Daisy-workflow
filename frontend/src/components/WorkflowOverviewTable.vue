<template>
    <div class="q-gutter-md">
<AppTable :rows="wf_rows" :columns="wf_columns" title="Workflows" />
     <AppTable :rows="trigger_rows" :columns="trigger_columns" title="Triggers" />
    </div>
    
</template>
<script setup>
import { ref, onMounted } from "vue";
import { Graphs,Triggers } from "../api/client";
import AppTable from "./AppTable.vue"
const selected = ref([]);
const wf_rows = ref([]);
const wf_columns = [{
    name: "action", label: "", style: "width:2px"
},
{ name: "name", label: "Name", field: "name", align: "left", sortable: true },
{ name: "version", label: "Version", field: "version", align: "left", sortable: true, style: "width: 10px;" },
{
    name: "updated", label: "Updated", field: "updated_at", align: "left", sortable: true,
    format: v => new Date(v).toLocaleString()
},
];
const trigger_rows = ref([]);
const trigger_columns =  [
  { name: "action",   label: "" ,style: "width:2px"},
  { name: "status",   label: "", style: "width: 70px;" },
  { name: "name",     label: "Name", field: "name", align: "left", sortable: true },
  { name: "type",     label: "Type", field: "type", align: "left", sortable: true, style: "width: 70px;" },
  { name: "graph",    label: "Flow", field: row => graphName(row.graph_id), align: "left" },
  { name: "fires",    label: "Fires", field: "fire_count", align: "right", style: "width: 60px;" },
  { name: "lastFired", label: "Last", field: "last_fired_at", align: "left",
    format: v => v ? new Date(v).toLocaleString() : "—" },
];
onMounted(async () => {
    wf_rows.value = await Graphs.list();
    trigger_rows.value =await Triggers.list();
})</script>