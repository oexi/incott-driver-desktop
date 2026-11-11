import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Tauri 用系统 webview：Linux WebKitGTK、macOS WebKit、Windows WebView2（Chromium）
    target: ['es2022', 'chrome110', 'safari16'],
    chunkSizeWarningLimit: 1500,
  },
  // tauri dev 的终端输出不要被 Vite 清屏
  clearScreen: false,
  server: { port: 5178, strictPort: true },
});
