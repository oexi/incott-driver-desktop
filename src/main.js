import './diaglog.js'; // 最先加载：捕获启动阶段的控制台错误
import { createApp } from 'vue';
import App from './App.vue';
import './styles/base.css';
import { applySettings } from './store.js';

applySettings();
createApp(App).mount('#app');

// 拖进窗口的文件默认会被浏览器打开（主进程也会拦下这次导航）：不接受拖放
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());
