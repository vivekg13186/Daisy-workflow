<template>
    <q-layout view="hHh lpR fFf" class="bg-grey-1">
        <q-drawer v-model="leftDrawer" side="left" bordered :width="300">
            <div>
                <div class="q-pa-md">
                    <q-input v-model="search" dense outlined placeholder="Search plugins..." rounded class="q-mb-md">
                        <template v-slot:append><q-icon name="search" /></template>
                    </q-input>
                </div>

                <q-list padding dense>
                    <q-expansion-item v-for="cat in filteredPlugins" dense :key="cat.name" :label="cat.name"
                        header-class="text-weight-bold bg-grey-12">
                        <q-card>
                            <q-list>
                                <q-item dense v-for="item in cat.items" :key="item.id" clickable v-ripple
                                    @click="addNode(item)">
                                    <q-item-section avatar>
                                        <q-icon :name="item.icon" color="primary" />
                                    </q-item-section>
                                    <q-item-section>{{ item.label }}</q-item-section>
                                </q-item>
                            </q-list>
                        </q-card>
                    </q-expansion-item>
                </q-list>
            </div>
        </q-drawer>

        <q-page-container>
            <q-page class="column">
                <div class="row">

                    <q-tabs v-model="tab" dense class="text-grey" active-color="primary" indicator-color="primary"
                        align="justify" narrow-indicator>
                        <q-tab name="ai" label="AI Assistant" />
                        <q-tab name="overview" label="Overview" />
                        <q-tab name="flow" label="Flow Canvas" />
                    </q-tabs>
                    <q-space></q-space>
                    <div>
                        <q-btn flat dense icon="save" color="primary"></q-btn>
                        <q-btn flat dense icon="play_arrow" color="secondary"></q-btn>
                        <q-btn flat dense icon="download" color="primary"></q-btn>
                        <q-btn flat dense icon="upload" color="primary"></q-btn>
                    </div>
                </div>


                <q-separator />

                <q-tab-panels v-model="tab" animated class="col">
                    <q-tab-panel name="ai">
                        <div class="column q-gutter-md">
                            <q-input v-model="aiPrompt" type="textarea" filled label="Describe your logic..."
                                hint="AI will generate nodes based on your text" />
                            <q-btn color="secondary" label="Generate Flow" icon="auto_awesome" />
                        </div>
                    </q-tab-panel>

                    <q-tab-panel name="overview">
                        <div class="row q-col-gutter-md">
                            <div class="col-12"><q-input v-model="meta.title" label="Workflow Title" /></div>
                            <div class="col-12"><q-input v-model="meta.description" type="textarea"
                                    label="Description" /></div>
                        </div>
                    </q-tab-panel>

                    <q-tab-panel name="flow" class="q-pa-none" style="height: 100%">
                        <VueFlow v-model="nodes" v-model:edges="edges" @node-double-click="onNodeClick"
                            fit-view-on-init>
                            <Background />
                            <Controls />
                        </VueFlow>
                    </q-tab-panel>
                </q-tab-panels>
            </q-page>
        </q-page-container>

        <q-drawer v-model="rightDrawer" side="right" bordered :width="350">
            <div v-if="selectedNode" class="q-pa-md">
                <div class="text-h6 q-mb-md">Properties: {{ selectedNode.label }}</div>

                <div v-if="selectedNode.data.type === 'email'" class="q-gutter-sm">
                    <q-input v-model="selectedNode.data.to" label="To" filled />
                    <q-input v-model="selectedNode.data.subject" label="Subject" filled />
                </div>

                <div v-else-if="selectedNode.data.type === 'file'" class="q-gutter-sm">
                    <q-input v-model="selectedNode.data.path" label="File Path" filled />
                    <q-select v-model="selectedNode.data.mode" :options="['Read', 'Write']" label="Mode" filled />
                </div>

                <div v-else>
                    <p class="text-caption">Generic Node Properties</p>
                    <q-input v-model="selectedNode.label" label="Display Name" filled />
                </div>
            </div>
            <div v-else class="flex flex-center full-height text-grey-6">
                Double click a node to edit properties
            </div>
        </q-drawer>
    </q-layout>
</template>

<script setup>
import { ref, computed } from 'vue'
import { VueFlow, useVueFlow } from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'

// Layout State
const leftDrawer = ref(true)
const rightDrawer = ref(true)
const tab = ref('flow')
const search = ref('')
const aiPrompt = ref('')

// Flow State
const nodes = ref([])
const edges = ref([])
const selectedNode = ref(null)
const meta = ref({ title: 'New Workflow', description: '' })

const { addNodes } = useVueFlow()

// Mock API Data for Plugins
const plugins = ref([
    {
        name: 'File IO',
        items: [
            { id: 'f1', label: 'Read File', icon: 'description', type: 'file', data: { path: '', mode: 'Read' } },
            { id: 'f2', label: 'Write File', icon: 'save_alt', type: 'file', data: { path: '', mode: 'Write' } }
        ]
    },
    {
        name: 'Communication',
        items: [
            { id: 'c1', label: 'Send Email', icon: 'email', type: 'email', data: { to: '', subject: '' } }
        ]
    }
])

const filteredPlugins = computed(() => {
    if (!search.value) return plugins.value
    return plugins.value.map(cat => ({
        ...cat,
        items: cat.items.filter(i => i.label.toLowerCase().includes(search.value.toLowerCase()))
    })).filter(cat => cat.items.length > 0)
})

// Logic
const addNode = (plugin) => {
    const newNode = {
        id: `node_${Date.now()}`,
        label: plugin.label,
        position: { x: Math.random() * 400, y: Math.random() * 400 },
        data: { ...plugin.data, type: plugin.type }, // deep copy of default data
    }
    nodes.value.push(newNode)
    tab.value = 'flow' // Switch to flow view when adding
}

const onNodeClick = ({ node }) => {
    selectedNode.value = node
    rightDrawer.value = true
}
</script>

<style>
/* Ensure the canvas fills the tab panel */
.vue-flow {
    background-color: #f8f9fa;
}
</style>