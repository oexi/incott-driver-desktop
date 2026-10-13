<script setup>
// 滑条下方的刻度：按数值精确定位到滑块圆点中心的位置
// 原生 range 的圆点中心在 [thumb/2, width - thumb/2] 区间内线性移动
defineProps({
  ticks: { type: Array, required: true }, // [{ value, label }]
  min: { type: Number, required: true },
  max: { type: Number, required: true },
  thumb: { type: Number, default: 20 },
});
</script>

<template>
  <div class="scale" :style="{ '--thumb': thumb + 'px' }">
    <span
      v-for="(tk, i) in ticks"
      :key="tk.value"
      class="tick"
      :class="{ first: i === 0 && tk.value === min, last: i === ticks.length - 1 && tk.value === max }"
      :style="{ '--p': (tk.value - min) / (max - min) }"
    >
      <i></i>{{ tk.label }}
    </span>
  </div>
</template>

<style scoped>
.scale {
  position: relative;
  height: 26px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
.tick {
  position: absolute;
  top: 0;
  left: calc(var(--thumb) / 2 + (100% - var(--thumb)) * var(--p));
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}
.tick i {
  width: 1px;
  height: 5px;
  background: color-mix(in srgb, var(--text) 22%, transparent);
}
/* 两端的文字向内对齐，避免超出卡片；刻度线仍对准圆点中心 */
.tick.first {
  transform: translateX(calc(var(--thumb) / -2));
  align-items: flex-start;
}
.tick.first i {
  margin-left: calc(var(--thumb) / 2);
}
.tick.last {
  transform: translateX(calc(-100% + var(--thumb) / 2));
  align-items: flex-end;
}
.tick.last i {
  margin-right: calc(var(--thumb) / 2);
}
</style>
