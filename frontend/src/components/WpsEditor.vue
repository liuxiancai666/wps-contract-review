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
 * WPS WebOffice 编辑器组件 v3 - 性能优化版
 * 
 * 优化点：
 * 1. wpsApplication 缓存 - 避免重复获取
 * 2. 应用实例获取队列 - 防止并发重复获取
 * 3. ready事件中自动缓存application
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
    
    // 性能优化：Application获取队列，防止并发重复获取
    let appResolveQueue = [];
    let isAppResolving = false;

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
        try { wpsInstance.destroy(); } catch {}
        wpsInstance = null;
      }
      
      // 重置状态
      wpsApplication = null;
      appResolveQueue = [];
      isAppResolving = false;

      try {
        loaded.value = false;
        sdkError.value = null;
        loadingText.value = 'WPS 文档加载中...';

        const SDK = window.WebOfficeSDK;

        const subscriptions = {
          ready: () => {
            loaded.value = true;
            emit('onDocumentReady');
            // 预获取并缓存application
            fetchAndCacheApplication();
          },
          documentStateChange: (event) => {
            const changed = event?.data;
            if (typeof changed === 'boolean') emit('onDocumentStateChange', changed);
          },
        };

        const h = props.config.headers;
        if (h?.backBtn?.subscribe) {
          subscriptions[h.backBtn.subscribe] = () => emit('onButtonAction', { action: 'back' });
        }
        if (h?.otherMenuBtn?.items) {
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

        wpsInstance = SDK.init(initConfig);
        if (!wpsInstance) {
          sdkError.value = 'WPS SDK init 返回空实例';
        }
      } catch (error) {
        console.error('[WPS Editor] Init error:', error);
        sdkError.value = error.message || 'WPS 编辑器初始化失败';
      }
    };

    // 性能优化：统一获取Application，支持队列等待
    const fetchAndCacheApplication = async () => {
      if (wpsApplication) return wpsApplication;
      if (!wpsInstance) return null;
      
      // 已在获取中，加入队列等待
      if (isAppResolving) {
        return new Promise((resolve, reject) => {
          appResolveQueue.push({ resolve, reject });
        });
      }
      
      isAppResolving = true;
      
      try {
        let app = null;
        if (typeof wpsInstance.WpsApplication === 'function') {
          app = await wpsInstance.WpsApplication();
        }
        if (!app && typeof wpsInstance.advancedApiReady === 'function') {
          app = await wpsInstance.advancedApiReady();
        }
        if (!app && typeof wpsInstance.ready === 'function') {
          app = await wpsInstance.ready();
        }
        
        wpsApplication = app;
        
        // resolve队列中的所有等待者
        appResolveQueue.forEach(({ resolve }) => resolve(app));
        appResolveQueue = [];
        
        return app;
      } catch (error) {
        // reject队列中的所有等待者
        appResolveQueue.forEach(({ reject }) => reject(error));
        appResolveQueue = [];
        return null;
      } finally {
        isAppResolving = false;
      }
    };

    // 对外暴露的getApplication - 使用缓存
    const getApplication = async () => {
      if (wpsApplication) return wpsApplication;
      return fetchAndCacheApplication();
    };

    const save = async () => {
      if (!wpsInstance || !wpsInstance.save) return null;
      try { return await wpsInstance.save(); } catch { return null; }
    };

    const retryInit = () => {
      sdkError.value = null;
      loaded.value = false;
      wpsApplication = null;
      nextTick(() => initEditor());
    };

    watch(
      () => props.config,
      (newVal) => {
        if (newVal && editorMount.value) {
          loaded.value = false;
          wpsApplication = null;
          appResolveQueue = [];
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
        appResolveQueue = [];
      }
    });

    return {
      editorMount, loaded, sdkError, loadingText,
      getApplication, save, retryInit,
    };
  },
});
</script>

<style scoped>
.wps-editor-wrapper { position: relative; overflow: hidden; }
.wps-editor-mount iframe { width: 100% !important; height: 100% !important; }
</style>
