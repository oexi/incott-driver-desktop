<script setup>
import { TriangleAlert, Info } from 'lucide-vue-next';
import { state } from '../store.js';
</script>

<template>
  <Transition name="modal">
    <div v-if="state.dialog" class="overlay" @mousedown.self="state.dialog.cancelText !== null && state.dialog.resolve(false)">
      <div class="dlg" :class="{ danger: state.dialog.danger }">
        <div class="ic" :class="state.dialog.icon">
          <TriangleAlert v-if="state.dialog.icon === 'warn'" :size="22" />
          <Info v-else :size="22" />
        </div>
        <h3>{{ state.dialog.title }}</h3>
        <p>{{ state.dialog.message }}</p>
        <div class="acts">
          <button v-if="state.dialog.cancelText !== null" class="btn" @click="state.dialog.resolve(false)">{{ state.dialog.cancelText }}</button>
          <button class="btn" :class="state.dialog.danger ? 'danger' : 'primary'" @click="state.dialog.resolve(true)">{{ state.dialog.okText }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  backdrop-filter: blur(6px);
  display: grid;
  place-items: center;
  z-index: 60;
}
.dlg {
  width: min(440px, calc(100vw - 48px));
  background: var(--surface);
  border: 1px solid var(--line-2);
  border-radius: var(--r-xl);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.45);
  padding: 24px;
}
.ic {
  width: 44px;
  height: 44px;
  border-radius: 14px;
  display: grid;
  place-items: center;
  background: var(--accent-soft);
  color: var(--accent);
  margin-bottom: 14px;
}
.ic.warn {
  background: color-mix(in srgb, var(--warn) 15%, transparent);
  color: var(--warn);
}
.danger .ic.warn {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
h3 {
  margin: 0 0 8px;
  font-size: 17px;
}
p {
  margin: 0;
  color: var(--text-2);
  line-height: 1.7;
  white-space: pre-line;
  font-size: 13.5px;
}
.acts {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 22px;
}
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.18s var(--ease);
}
.modal-enter-active .dlg {
  transition: transform 0.22s var(--ease);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .dlg {
  transform: scale(0.96);
}
</style>
