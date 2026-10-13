<script setup>
import { computed, onMounted } from 'vue';
import { state, autoConnect, initHidEvents } from './store.js';
import TitleBar from './components/TitleBar.vue';
import Sidebar from './components/Sidebar.vue';
import PageHeader from './components/PageHeader.vue';
import Welcome from './pages/Welcome.vue';
import ButtonsPage from './pages/ButtonsPage.vue';
import PerformancePage from './pages/PerformancePage.vue';
import AdvancedPage from './pages/AdvancedPage.vue';
import MacrosPage from './pages/MacrosPage.vue';
import SettingsModal from './components/SettingsModal.vue';
import ConfirmDialog from './components/ConfirmDialog.vue';
import Toasts from './components/Toasts.vue';
import ProgressOverlay from './components/ProgressOverlay.vue';
import FirstRunBanner from './components/FirstRunBanner.vue';

const pages = {
  buttons: ButtonsPage,
  performance: PerformancePage,
  advanced: AdvancedPage,
  macros: MacrosPage,
};
const pageComp = computed(() => pages[state.page] || ButtonsPage);
const platform = window.desktop?.platform || 'web';

onMounted(() => {
  initHidEvents();
  autoConnect();
});
</script>

<template>
  <div class="app" :class="`pf-${platform}`">
    <TitleBar />
    <div class="app-body">
      <Transition name="fade" mode="out-in">
        <Welcome v-if="state.phase !== 'ready'" key="welcome" />
        <div v-else key="main" class="workspace">
          <Sidebar />
          <main class="main">
            <PageHeader />
            <FirstRunBanner />
            <div class="page-scroll">
              <Transition name="page">
                <component :is="pageComp" :key="state.page + state.curIndex" />
              </Transition>
            </div>
          </main>
        </div>
      </Transition>
    </div>
    <SettingsModal />
    <ConfirmDialog />
    <ProgressOverlay />
    <Toasts />
  </div>
</template>

<style>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(1200px 600px at 85% -10%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 60%),
    var(--bg);
}
.app-body {
  flex: 1;
  min-height: 0;
  display: flex;
}
.workspace {
  flex: 1;
  display: flex;
  min-width: 0;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.page-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 4px 28px 28px;
}
</style>
