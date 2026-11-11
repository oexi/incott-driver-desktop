import './platform/tauri.js'; // 最先加载：Tauri 版的 window.desktop / navigator.hid（diaglog、store 在加载时就要用）
import './diaglog.js'; // 尽早加载：捕获启动阶段的控制台错误
import { createApp } from 'vue';
import App from './App.vue';
import './styles/base.css';
import { applySettings } from './store.js';

applySettings();
createApp(App).mount('#app');
// 启动时界面准备好后再露出窗口（见 src-tauri/src/main.rs 的 reveal）
const reveal = () => window.desktop?.win?.reveal?.();
// Linux：窗口可见、内容透明，两次 rAF = 至少画完一帧；Windows / macOS：窗口隐藏中，界面挂载好就显示
if (window.desktop?.platform === 'linux') requestAnimationFrame(() => requestAnimationFrame(reveal));
else reveal();

// 拖进窗口的文件默认会被浏览器打开（主进程也会拦下这次导航）：不接受拖放
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
