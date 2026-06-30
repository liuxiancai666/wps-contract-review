<template>
  <div class="wps-editor-wrapper w-full h-full relative">
    <div ref="editorMount" class="wps-editor-mount w-full h-full"></div>
    <!-- 加载中提示 / 重新加载动画 -->
    <div v-if="!loaded" class="absolute inset-0 flex items-center justify-center bg-white bg-opacity-80 z-10">
      <div class="text-center">
        <svg class="animate-spin h-8 w-8 mx-auto text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <p class="mt-2 text-sm text-text-light">{{ loadingText }}</p>
      </div>
    </div>
    <!-- SDK 错误提示 + 重试按钮 -->
    <div v-if="sdkError" class="absolute inset-0 flex items-center justify-center bg-white bg-opacity-90 z-10">
      <div class="text-center p-6">
        <svg class="mx-auto h-10 w-10 text-red-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        <p class="mt-2 text-sm text-red-700">WPS 编辑器初始化失败</p>
        <p class="mt-1 text-xs text-red-500">{{ sdkError }}</p>
        <button @click="retryInit" class="mt-3 px-4 py-1.5 text-sm font-medium text-white bg-primary rounded hover:bg-primary-dark">重试</button>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted, watch, nextTick, defineComponent } from 'vue';

/**
 * WPS WebOffice 编辑器组件 v2
 *
 * Props:
 * - config: WPS SDK init 配置对象
 * - customButtons: 额外自定义按钮订阅映射 { key: callback }
 *
 * Events:
 * - onDocumentReady, onDocumentStateChange, onButtonAction
 */
export default defineComponent({
  name: 'WpsEditor',
  props: {
    config: { type: Object, default: null },
  },
  emits: ['onDocumentReady', 'onDocumentStateChange', 'onButtonAction', 'onError'],
  setup(props, { emit }) {
    const editorMount = ref(null);
    const loaded = ref(false);
    const sdkError = ref(null);
    const loadingText = ref('WPS 文档加载中...');
    let wpsInstance = null;
    let wpsApplication = null;

    const loadSDK = () => {
      if (typeof window.WebOfficeSDK === 'undefined') {
        const script = document.createElement('script');
        script.src = '/wps-sdk/web-office-sdk-solution-v2.0.7.umd.js';
        script.onload = initEditor;
        script.onerror = () => { sdkError.value = 'WPS SDK 加载失败'; };
        document.head.appendChild(script);
      } else {
        initEditor();
      }
    };

    const initEditor = async () => {
      if (!props.config || !editorMount.value) return;

      if (wpsInstance) {
        try { wpsInstance.destroy(); wpsApplication = null; } catch {}
        wpsInstance = null;
      }

      try {
        loaded.value = false;
        sdkError.value = null;
        loadingText.value = 'WPS 文档加载中...';

        const SDK = window.WebOfficeSDK;

        // 构建 subscriptions：包含 SDK 基础事件 + 自定义按钮回调
        const subscriptions = {
          // SDK 基础事件
          ready: () => {
            loaded.value = true;
            emit('onDocumentReady');
            wpsInstance.ready().then(app => { wpsApplication = app; }).catch(() => {});
            if (typeof wpsInstance.advancedApiReady === 'function') {
              wpsInstance.advancedApiReady().then(adv => { if (adv && !wpsApplication) wpsApplication = adv; }).catch(() => {});
            }
          },
          // 文档状态变化
          documentStateChange: (event) => {
            const changed = event?.data;
            if (typeof changed === 'boolean') emit('onDocumentStateChange', changed);
          },
        };

        // 从配置的 headers 中自动构建按钮订阅
        // 这些 subscribe 键名由 SDK 的 handleHeadersAndSubscriptionsConfig 生成：
        // backBtn → 'wpsconfig_back_btn', otherMenuBtn items → 'wpsconfig_other_menu_btn_N'
        const h = props.config.headers;
        if (h?.backBtn?.subscribe) {
          subscriptions[h.backBtn.subscribe] = () => emit('onButtonAction', { action: 'back' });
        }
        if (h?.otherMenuBtn?.items) {
          let customIdx = 0;
          h.otherMenuBtn.items.forEach((item) => {
            if (item.subscribe && typeof item.subscribe === 'string') {
              subscriptions[item.subscribe] = () => emit('onButtonAction', { action: item.subscribe, text: item.text });
            }
          });
        }

        const initConfig = {
          ...props.config,
          mount: editorMount.value,
          subscriptions,
          // refreshToken 回调：自动续期 Token，从 /api/contracts/{id}/editor-config 获取
          refreshToken: async () => {
            try {
              const fileId = props.config?.fileId || '';
              const numericId = fileId.replace(/^contract-/, '');
              const resp = await fetch(`/api/contracts/${numericId}/editor-config`);
              const data = await resp.json();
              const ec = data.editorConfig || data;
              return { token: ec.token, timeout: 82800 };
            } catch {
              return { token: '', timeout: 82800 };
            }
          },
        };
        // 移除 headers（SDK 的 userConfHandler 会读取 headers 生成内部订阅，
        // 但我们已经在 subscriptions 中提供了回调，headers 中的 subscribe 字符串会被 SDK 忽略）
        // 保留 headers 让 SDK 正确显示 UI 元素

        wpsInstance = SDK.init(initConfig);
        if (!wpsInstance) {
          sdkError.value = 'WPS SDK init 返回空实例';
        }
      } catch (error) {
        console.error('[WPS Editor] Init error:', error);
        sdkError.value = error.message || 'WPS 编辑器初始化失败';
      }
    };

    const getApplication = async () => {
      if (wpsApplication) return wpsApplication;
      if (!wpsInstance) return null;
      try {
        if (typeof wpsInstance.WpsApplication === 'function') {
          const app = await wpsInstance.WpsApplication();
          if (app) { wpsApplication = app; return app; }
        }
        if (typeof wpsInstance.ready === 'function') {
          const app = await wpsInstance.ready();
          if (app) { wpsApplication = app; return app; }
        }
        if (typeof wpsInstance.advancedApiReady === 'function') {
          const app = await wpsInstance.advancedApiReady();
          if (app) { wpsApplication = app; return app; }
        }
      } catch (error) {
        console.error('[WPS Editor] Failed to get Application:', error);
      }
      return null;
    };

    const save = async () => {
      if (!wpsInstance || !wpsInstance.save) return null;
      try { return await wpsInstance.save(); } catch { return null; }
    };

    const advancedApiReady = async () => {
      if (!wpsInstance || !wpsInstance.advancedApiReady) return null;
      try { return await wpsInstance.advancedApiReady(); } catch { return null; }
    };

    const retryInit = () => {
      sdkError.value = null;
      loaded.value = false;
      nextTick(() => initEditor());
    };

    watch(
      () => props.config,
      (newVal) => {
        if (newVal && editorMount.value) {
          loaded.value = false;
          wpsApplication = null;
          nextTick(() => initEditor());
        }
      },
      { deep: true }
    );

    onMounted(() => { nextTick(() => loadSDK()); });

    onUnmounted(() => {
      if (wpsInstance) {
        try { wpsInstance.destroy(); } catch {}
        wpsInstance = null;
        wpsApplication = null;
      }
    });

    return {
      editorMount, loaded, sdkError, loadingText,
      getApplication, save, advancedApiReady, retryInit,
    };
  },
});
</script>

<style scoped>
.wps-editor-wrapper { position: relative; overflow: hidden; }
.wps-editor-mount iframe { width: 100% !important; height: 100% !important; }
</style>
