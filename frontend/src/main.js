import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import 'element-plus/dist/index.css';
import './assets/css/tailwind.css';
import { identifyUser } from './user';

document.title = '牛马在线 - 合同审查';
const favicon = document.querySelector('link[rel="icon"]') || document.createElement('link');
favicon.rel = 'icon';
favicon.href = '/favicon.ico';
document.head.appendChild(favicon);

async function main() {
  // 尝试识别用户（指纹），即使失败也不阻塞应用——未登录用户会看到登录页
  try {
    await identifyUser();
  } catch (error) {
    console.warn('[App] User identification skipped:', error.message);
  }

  const app = createApp(App);
  app.use(router);
  app.mount('#app');
}

main();

// 注意：全局覆盖 ResizeObserver 会影响所有第三方库，已移除。
// 如需防抖，请在具体组件内使用 ResizeObserver + requestAnimationFrame。
