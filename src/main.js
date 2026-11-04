import './diaglog.js'; // 最先加载：捕获启动阶段的控制台错误
import { createApp } from 'vue';
import App from './App.vue';
import './styles/base.css';
import { applySettings } from './store.js';

applySettings();
createApp(App).mount('#app');
