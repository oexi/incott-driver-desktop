import { createApp } from 'vue';
import App from './App.vue';
import './styles/base.css';
import { applySettings } from './store.js';

applySettings();
createApp(App).mount('#app');
