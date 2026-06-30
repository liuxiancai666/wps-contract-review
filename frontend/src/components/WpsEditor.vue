<template>
  <div class="wps-editor-wrapper w-full h-full relative">
    <!-- WPS WebOffice iframe 将挂载到此节点 -->
    <div ref="editorMount" class="wps-editor-mount w-full h-full"></div>
    <!-- 加载中提示 -->
    <div v-if="!loaded" class="absolute inset-0 flex items-center justify-center bg-white bg-opacity-80 z-10">
      <div class="text-center">
        <svg class="animate-spin h-8 w-8 mx-auto text-primary" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        <p class="mt-2 text-sm text-text-light">WPS 文档加载中...</p>
      </div>
    </div>
    <!-- SDK 错误提示 -->
    <div v-if="sdkError" class="absolute inset-0 flex items-center justify-center bg-white bg-opacity-90 z-10">
      <div class="text-center p-6">
        <svg class="mx-auto h-10 w-10 text-red-500" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
        <p class="mt-2 text-sm text-red-700">WPS 编辑器初始化失败</p>
        <p class="mt-1 text-xs text-red-500">{{ sdkError }}</p>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, onMounted, onUnmounted, watch, nextTick, defineComponent } from 'vue';

/**
 * WPS WebOffice 编辑器组件
 * 
 * 替代 @onlyoffice/document-editor-vue
 * 
 * Props:
 * - config: WPS SDK init 配置对象（由后端 buildWpsEditorConfig 生成）
 * 
 * Events:
 * - onDocumentReady: 文档就绪
 * - onDocumentStateChange: 文档状态变化（isDirty）
 * 
 * Exposed Methods (通过 ref 访问):
 * - getApplication(): 获取 WpsApplication 实例（用于 JSAPI 调用）
 * - save(): 主动保存
 * - advancedApiReady(): 获取高级 API 实例
 */
export default defineComponent({
  name: 'WpsEditor',
  props: {
    config: {
      type: Object,
      default: null,
    },
  },
  emits: ['onDocumentReady', 'onDocumentStateChange'],
  setup(props, { emit }) {
    const editorMount = ref(null);
    const loaded = ref(false);
    const sdkError = ref(null);
    let wpsInstance = null;
    let wpsApplication = null;  // 缓存 Application 对象

    // 加载 SDK
    const loadSDK = () => {
      // SDK 已通过 index.html 全局引入（web-office-sdk-solution.umd.js）
      if (typeof window.WebOfficeSDK === 'undefined') {
        // 如果尚未加载，动态加载
        const script = document.createElement('script');
        script.src = '/wps-sdk/web-office-sdk-solution-v2.0.7.umd.js';
        script.onload = initEditor;
        script.onerror = () => {
          sdkError.value = 'WPS SDK 加载失败';
        };
        document.head.appendChild(script);
      } else {
        initEditor();
      }
    };

    // 初始化编辑器
    const initEditor = async () => {
      if (!props.config || !editorMount.value) return;

      // 清理旧实例
      if (wpsInstance) {
        try { 
          wpsInstance.destroy(); 
          wpsApplication = null;
        } catch {}
        wpsInstance = null;
      }

      try {
        const SDK = window.WebOfficeSDK;
        const initConfig = {
          ...props.config,
          mount: editorMount.value,
          // 事件订阅
          subscriptions: {
            ready: () => {
              loaded.value = true;
              // 当 SDK ready 后，获取 Application 对象供后续 JSAPI 调用
              emit('onDocumentReady');
              // 尝试预加载 Application
              wpsInstance.ready().then(app => {
                wpsApplication = app;
              }).catch(() => {
                // 某些 SDK 版本 ready 返回 void，通过 advancedApiReady 获取
              });
              // 同时尝试 advancedApiReady
              if (typeof wpsInstance.advancedApiReady === 'function') {
                wpsInstance.advancedApiReady().then(adv => {
                  if (adv && !wpsApplication) {
                    wpsApplication = adv;
                  }
                }).catch(() => {});
              }
            },
            // 文档状态变化
            documentStateChange: (event) => {
              const changed = event?.data;
              if (typeof changed === 'boolean') {
                emit('onDocumentStateChange', changed);
              }
            },
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

    // 获取 WpsApplication 实例（用于 JSAPI 调用）
    const getApplication = async () => {
      // 优先使用缓存的 Application
      if (wpsApplication) return wpsApplication;
      
      if (!wpsInstance) return null;
      
      // 尝试多种方式获取 Application
      try {
        // 方式1: WpsApplication() (JSAPI 途径)
        if (typeof wpsInstance.WpsApplication === 'function') {
          const app = await wpsInstance.WpsApplication();
          if (app) {
            wpsApplication = app;
            return app;
          }
        }
        // 方式2: ready() 获取
        if (typeof wpsInstance.ready === 'function') {
          const app = await wpsInstance.ready();
          if (app) {
            wpsApplication = app;
            return app;
          }
        }
        // 方式3: advancedApiReady()
        if (typeof wpsInstance.advancedApiReady === 'function') {
          const app = await wpsInstance.advancedApiReady();
          if (app) {
            wpsApplication = app;
            return app;
          }
        }
      } catch (error) {
        console.error('[WPS Editor] Failed to get Application:', error);
      }
      return null;
    };

    // 执行保存
    const save = async () => {
      if (!wpsInstance || !wpsInstance.save) return null;
      try {
        return await wpsInstance.save();
      } catch (error) {
        console.warn('[WPS Editor] Save failed:', error);
        return null;
      }
    };

    // 高级 API 就绪
    const advancedApiReady = async () => {
      if (!wpsInstance || !wpsInstance.advancedApiReady) return null;
      try {
        return await wpsInstance.advancedApiReady();
      } catch {
        return null;
      }
    };

    // 监听 config 变化
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

    onMounted(() => {
      nextTick(() => loadSDK());
    });

    onUnmounted(() => {
      if (wpsInstance) {
        try { wpsInstance.destroy(); } catch {}
        wpsInstance = null;
        wpsApplication = null;
      }
    });

    return {
      editorMount,
      loaded,
      sdkError,
      getApplication,
      save,
      advancedApiReady,
    };
  },
});
</script>

<style scoped>
.wps-editor-wrapper {
  position: relative;
  overflow: hidden;
}
.wps-editor-mount iframe {
  width: 100% !important;
  height: 100% !important;
}
</style>
