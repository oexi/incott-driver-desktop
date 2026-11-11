// 图片资源路径（相对 index.html，打包后通过 file:// 加载也能正确解析）

import { computed, ref } from 'vue';
import { state, settings } from './store.js';
import { t } from './i18n.js';

const KNOWN = ['G23', 'G24', 'G23V2', 'G29', 'FM23', 'Ghero'];

// 鼠标不上报外壳颜色（只有零29 上报粉色），由用户在设置里手动选择。
// 列出的是默认图片之外的配色，图片在 mice/{dark,light}/<型号>-<配色>/ 和 products/<型号>-<配色>.webp，
// 由默认橙色渲染图重新上色得到。
export const SHELLS = { G23: ['White', 'Red'] };

/** 当前型号所选的外壳配色，未选择或无此配色时为 null（使用默认图片）。 */
export function shellOf(model = modelDir()) {
  const s = settings.shell?.[model];
  return SHELLS[model]?.includes(s) ? s : null;
}

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
  const theme = themeName.value === 'light' ? 'light' : 'dark';
  if (state.info.pink) return `./mice/pink/${modelDir()}/${index + 1}.webp`;
  const shell = shellOf();
  const dir = shell ? `${modelDir()}-${shell}` : modelDir();
  return `./mice/${theme}/${dir}/${index + 1}.webp`;
}

export const productImage = computed(() => {
  const m = modelDir();
  if (m === 'G29' && state.info.pink) return './products/G29-Pink.webp';
  const shell = shellOf(m);
  return shell ? `./products/${m}-${shell}.webp` : `./products/${m}.webp`;
});

/** 界面上显示的型号名：零29 / 零39 的内部名是 G29 / FM23（见 modelFromCode） */
export function displayName(devname) {
  return devname ? (t.value.modelNames?.[devname] ?? devname) : '';
}
