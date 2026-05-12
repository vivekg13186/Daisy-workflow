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
  The floating UserMenu lives at top:6px / right:8px and now holds
  TWO 36x36 buttons (theme toggle + avatar) with a 6px gap. Reserve
  that space globally so the toolbar's last button stops short of
  the floating cluster regardless of which page is mounted.
*/
.q-toolbar {
  padding-right: 96px !important;
}
</style>
