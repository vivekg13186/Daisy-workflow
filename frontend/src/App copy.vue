<script setup>
import { ref } from "vue";
import GraphList from "./components/GraphList.vue";
import Workspace from "./components/Workspace.vue";
import FlowEditorWIP from "./components/FlowEditorWIP.vue"
const splitter = ref(22);  // % width of the left pane
</script>

<template>
  <q-layout view="hHh lpR fFf" >
    <q-page-container>
      <q-page class="row no-wrap" style="height: 100vh;">
        <q-splitter
          v-model="splitter"
          :limits="[15, 45]"
          unit="%"
          style="height: 100vh; width: 100%;"
        >
          <template v-slot:before>
            <GraphList />
          </template>
          <template v-slot:after>
           <Workspace/>
          </template>
        </q-splitter>
      </q-page>
    </q-page-container>
  </q-layout>
</template>
