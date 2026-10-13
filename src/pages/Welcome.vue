<script setup>
import { ref, computed } from 'vue';
import { Plug, LoaderCircle, ShieldCheck, TriangleAlert, Copy } from 'lucide-vue-next';
import { state, userConnect, checkLinuxPermission, toast } from '../store.js';
import { t } from '../i18n.js';

const installing = ref(false);
const installResult = ref(null);
const busy = computed(() => state.phase === 'connecting');
const heroImg = './products/G23.webp';

const RULES = `sudo tee /etc/udev/rules.d/70-incott-mouse.rules >/dev/null <<'EOF'
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="093a", ATTRS{idProduct}=="522c", MODE="0666", TAG+="uaccess"
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="093a", ATTRS{idProduct}=="622c", MODE="0666", TAG+="uaccess"
EOF
sudo udevadm control --reload-rules && sudo udevadm trigger`;

async function installUdev() {
  installing.value = true;
  installResult.value = await window.desktop.linux.installUdev();
  installing.value = false;
  if (installResult.value.ok) {
    toast(t.value.linuxPermDone, 'success', 5000);
    setTimeout(checkLinuxPermission, 1500);
  }
}

function copyRules() {
  navigator.clipboard.writeText(RULES);
  toast('✓', 'success', 1200);
}
</script>

<template>
  <section class="welcome">
    <div class="hero-text">
      <div class="eyebrow">INCOTT · DESKTOP DRIVER</div>
      <h1>{{ t.welcomeTitle }}</h1>
      <p class="lead">{{ t.welcomeSub }}</p>

      <div class="status-card">
        <template v-if="state.linuxPerm?.needsFix">
          <div class="st-head warn"><ShieldCheck :size="18" />{{ t.linuxPermTitle }}</div>
          <p class="st-desc">{{ t.linuxPermDesc }}</p>
          <div class="row">
            <button class="btn primary" :disabled="installing" @click="installUdev">
              <LoaderCircle v-if="installing" :size="16" class="spin" />
              <ShieldCheck v-else :size="16" />
              {{ t.linuxPermFix }}
            </button>
            <button class="btn" :disabled="busy" @click="userConnect()">{{ t.reconnect }}</button>
          </div>
          <div v-if="installResult && !installResult.ok" class="manual">
            <div class="muted">{{ t.linuxPermFailed }}</div>
            <pre class="mono">{{ RULES }}</pre>
            <button class="btn sm" @click="copyRules"><Copy :size="13" />Copy</button>
          </div>
        </template>

        <template v-else-if="busy">
          <div class="st-head"><LoaderCircle :size="18" class="spin accent" />{{ t.connecting }}</div>
        </template>

        <template v-else>
          <div v-if="state.error" class="st-head err"><TriangleAlert :size="18" />{{ state.error.title }}</div>
          <div v-else-if="state.scanning" class="st-head"><LoaderCircle :size="18" class="spin accent" />{{ t.searching }}</div>
          <div v-else class="st-head">{{ t.noDevice }}</div>
          <p class="st-desc">{{ state.error ? state.error.message : t.noDeviceHint }}</p>
          <button class="btn primary lg" @click="userConnect()"><Plug :size="18" />{{ t.connect }}</button>
        </template>
      </div>

      <div class="supported muted">{{ t.supported }}</div>
    </div>

    <div class="hero-art">
      <div class="ring r1"></div>
      <div class="ring r2"></div>
      <div class="ring r3"></div>
      <div class="halo"></div>
      <img class="mouse" :src="heroImg" alt="" />
    </div>
  </section>
</template>

<style scoped>
.welcome {
  flex: 1;
  display: grid;
  grid-template-columns: minmax(380px, 1.05fr) 1fr;
  align-items: center;
  gap: 40px;
  padding: 0 7vw 40px;
  min-width: 0;
}
.eyebrow {
  font-size: 12px;
  letter-spacing: 0.28em;
  color: var(--accent);
  font-weight: 700;
}
h1 {
  font-size: clamp(30px, 3.6vw, 46px);
  line-height: 1.15;
  margin: 14px 0 16px;
  letter-spacing: 0.01em;
  background: linear-gradient(180deg, var(--text), color-mix(in srgb, var(--text) 70%, transparent));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.lead {
  color: var(--text-2);
  font-size: 14.5px;
  line-height: 1.75;
  max-width: 520px;
  margin: 0 0 28px;
}
.status-card {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--r-xl);
  padding: 20px 22px;
  max-width: 520px;
  box-shadow: var(--shadow);
}
.st-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 700;
  font-size: 15px;
}
.st-head.err svg {
  color: var(--danger);
}
.st-head.warn svg {
  color: var(--warn);
}
.st-desc {
  color: var(--text-3);
  margin: 8px 0 16px;
  font-size: 13px;
  line-height: 1.65;
}
.accent {
  color: var(--accent);
}
.supported {
  margin-top: 18px;
  font-size: 12px;
}
.manual {
  margin-top: 14px;
}
.manual pre {
  font-size: 11px;
  background: var(--bg-2);
  border: 1px solid var(--line);
  padding: 10px 12px;
  border-radius: var(--r-sm);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
  margin: 6px 0 8px;
}
.spin {
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.hero-art {
  position: relative;
  height: min(70vh, 560px);
  display: grid;
  place-items: center;
}
.mouse {
  position: relative;
  height: 72%;
  max-height: 420px;
  object-fit: contain;
  filter: drop-shadow(0 40px 40px rgba(0, 0, 0, 0.45));
  animation: float 7s ease-in-out infinite;
}
.halo {
  position: absolute;
  width: 60%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 40%, transparent), transparent);
  filter: blur(20px);
}
.ring {
  position: absolute;
  border-radius: 50%;
  border: 1px solid var(--line-2);
  aspect-ratio: 1;
}
.r1 {
  width: 46%;
  animation: breathe 6s ease-in-out infinite;
}
.r2 {
  width: 66%;
  opacity: 0.7;
  animation: breathe 6s ease-in-out 1s infinite;
}
.r3 {
  width: 88%;
  opacity: 0.4;
  border-style: dashed;
  animation: rot 60s linear infinite;
}
@keyframes float {
  50% {
    transform: translateY(-12px) rotate(-1.5deg);
  }
}
@keyframes breathe {
  50% {
    transform: scale(1.04);
    opacity: 0.4;
  }
}
@keyframes rot {
  to {
    transform: rotate(360deg);
  }
}
@media (max-width: 1150px) {
  .welcome {
    grid-template-columns: 1fr 0.8fr;
    padding: 0 5vw 30px;
  }
}
</style>
