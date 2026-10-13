// 图片资源路径（相对 index.html，打包后通过 file:// 加载也能正确解析）

import { computed, ref } from 'vue';
import { state } from './store.js';

const KNOWN = ['G23', 'G24', 'G23V2', 'G29', 'FM23', 'Ghero'];

export const themeName = ref(document.documentElement.dataset.theme || 'dark');
new MutationObserver(() => (themeName.value = document.documentElement.dataset.theme || 'dark')).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ['data-theme'],
});

export function modelDir() {
  return KNOWN.includes(state.info.devname) ? state.info.devname : 'G23';
}

/** 按键示意图：index = -1 显示全部编号，0..5 高亮对应按键 */
export function mouseMapImage(index) {
  const set = state.info.pink ? 'pink' : themeName.value === 'light' ? 'light' : 'dark';
  return `./mice/${set}/${modelDir()}/${index + 1}.webp`;
}

export const productImage = computed(() => {
  const m = modelDir();
  if (m === 'G29' && state.info.pink) return './products/G29-Pink.webp';
  return `./products/${m}.webp`;
});

export function displayName(devname) {
  return devname ? `INCOTT ${devname}` : 'INCOTT';
}
