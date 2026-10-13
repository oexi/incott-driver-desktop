<script setup>
import { CircleCheck, CircleAlert, TriangleAlert, Info } from 'lucide-vue-next';
import { state } from '../store.js';
const icons = { success: CircleCheck, error: CircleAlert, warn: TriangleAlert, info: Info };
</script>

<template>
  <div class="toasts">
    <TransitionGroup name="toast">
      <div v-for="x in state.toasts" :key="x.id" class="toast" :class="x.type">
        <component :is="icons[x.type] || Info" :size="16" />
        <span>{{ x.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  right: 24px;
  bottom: 24px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  z-index: 80;
  pointer-events: none;
}
.toast {
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 420px;
  padding: 11px 16px;
  border-radius: var(--r-md);
  background: var(--surface-3);
  border: 1px solid var(--line-2);
  box-shadow: var(--shadow);
  font-size: 13px;
  font-weight: 600;
}
.toast.success svg {
  color: var(--ok);
}
.toast.error svg {
  color: var(--danger);
}
.toast.warn svg {
  color: var(--warn);
}
.toast.info svg {
  color: var(--accent);
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.25s var(--ease);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
