<script setup>
import { RouterView } from "vue-router";
import UserMenu from "./components/UserMenu.vue";
</script>

<template>
  <RouterView />
  <!-- Floating top-right avatar with menu (workspace, settings, logout).
       Auto-hidden on /login. See components/UserMenu.vue. -->
  <UserMenu />
</template>

<style>
/*
  The floating UserMenu lives at top:6px / right:8px with a 36x36
  footprint, so it would otherwise sit on top of whatever a page
  parks in the right edge of its q-toolbar (Refresh, Save, etc.).
  Reserve that space globally so the toolbar's last button stops
  short of the avatar.
*/
.q-toolbar {
  padding-right: 52px !important;
}
</style>
