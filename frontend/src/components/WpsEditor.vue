<template>
  <div class="wps-editor-wrapper w-full h-full flex flex-col relative">
    <div ref="editorMount" id="file-views-wps" class="wps-editor-mount w-full flex-1"></div>
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
import { getUserId } from '../user';

/**
 * WPS WebOffice 编辑器组件 - 参考网站方式
 * 
 * 使用参考网站 xingfa.cjbdi.com 的接入方式：
 * 1. 调用 /api/contracts/:id/wps-config 获取 appId, fileSuffix, mode
 * 2. 调用 /api/contracts/:id/wps-download 获取下载 URL
 * 3. 使用 xingfa-sdk.js 初始化 WPS SDK
 * 
 * Props:
 * - contractId: 合同 ID
 * - mode: 'simple' | 'edit'
 *
 * Events:
 * - onDocumentReady, onDocumentStateChange, onButtonAction, onError
 */
export default defineComponent({
  name: 'WpsEditor',
  props: {
    contractId: { type: [String, Number], required: true },
    mode: { type: String, default: 'simple' },
  },
  emits: ['onDocumentReady', 'onDocumentStateChange', 'onButtonAction', 'onError'],
  setup(props, { emit }) {
    const editorMount = ref(null);
    const loaded = ref(false);
    const sdkError = ref(null);
    const loadingText = ref('WPS 文档加载中...');
    
    let wpsInstance = null;
    let wpsApplication = null;
    let appResolveQueue = [];
    let isAppResolving = false;

    // 参考网站方式：从 cookies 获取 token
    const getTokenFromCookie = () => {
      const match = document.cookie.match(/(?:^|;\s*)token=([^;]*)/);
      return match ? decodeURIComponent(match[1]) : '';
    };

    // 参考网站方式：refreshToken 函数
    const getRefreshToken = () => {
      const token = getTokenFromCookie();
      return Promise.resolve({ token, timeout: 600 * 1000 });
    };

    // 加载 WPS SDK（使用官方 UMD SDK）
    const loadSDK = () => {
      return new Promise((resolve, reject) => {
        if (typeof window.WebOfficeSDK !== 'undefined') {
          resolve();
          return;
        }
        const script = document.createElement('script');
        script.src = '/wps-sdk/web-office-sdk-solution-v2.0.7.umd.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('WPS SDK 加载失败'));
        document.head.appendChild(script);
      });
    };

    // 初始化 WPS 编辑器
    const initEditor = async () => {
      if (!editorMount.value) return;

      try {
        loaded.value = false;
        sdkError.value = null;
        loadingText.value = '获取 WPS 配置...';

        const numericId = Number(props.contractId);

        // 1. 调用 /api/contracts/:id/wps-config 获取配置（参考网站方式）
        loadingText.value = '获取 WPS 配置...';
        const configResp = await fetch(`/api/contracts/${numericId}/wps-config`, {
          headers: { 'X-User-ID': getUserId() || '' }
        });
        if (!configResp.ok) throw new Error('获取 WPS 配置失败');
        const wpsConfig = await configResp.json();

        // 2. 使用参考网站(xingfa.cjbdi.com)方式初始化 SDK
        loadingText.value = 'WPS 文档加载中...';

        const SDK = window.WPS || window.WebOfficeSDK;
        if (!SDK) throw new Error('WPS SDK 未加载');

        // 参考网站的初始化参数（完全对齐）
        // token 直接使用 wps-config API 返回的 JWT，不再从 cookie 读
        const sdkToken = wpsConfig.token || getTokenFromCookie();
        const initConfig = {
          officeType: wpsConfig.fileSuffix || 'w',
          appId: wpsConfig.appId,
          endpoint: wpsConfig.endpoint || 'https://o.wpsgo.com',
          fileId: wpsConfig.fileId || `contract-${numericId}`,
          mode: wpsConfig.mode || 'simple',
          mount: '#file-views-wps',
          // 不传 callbackUrl：SDK v2 通过 token 直连 WPS 服务器，不需要回调
          token: sdkToken,
          refreshToken: getRefreshToken,
          commonOptions: {
            isShowTopArea: false,   // 参考网站：false → URL 加 simple&hidecmb
            isShowHeader: false,    // 参考网站：false
            isBrowserViewFullscreen: false,
            isIframeViewFullscreen: false,
            acceptVisualViewportResizeEvent: true,
          },
          wpsOptions: {
            isShowDocMap: true,
            isBestScale: false,
          },
          // userProvider: SDK 内部 UserProvider 校验所需的回调
          // update=1 时 SDK 会调用此接口获取用户信息用于本地校验
          userProvider: {
            getUsers: async (params) => {
              // 调用后端 /v3/3rd/users 接口（通过 nginx 代理）
              const userIds = params?.userIds || [];
              const query = userIds.map(id => `user_ids=${id}`).join('&');
              const url = `/v3/3rd/users${query ? '?' + query : ''}`;
              try {
                const resp = await fetch(url);
                if (!resp.ok) return [];
                const data = await resp.json();
                // 转换后端格式为 SDK 期望的格式
                if (data.code === 0 && Array.isArray(data.result)) {
                  return data.result.map(u => ({
                    userId: u.uid || u.user_id || u.id,
                    name: u.name || u.username || '用户',
                    permission: u.permission || 1,
                  }));
                }
                return [];
              } catch {
                return [];
              }
            },
          },
          subscriptions: {
            ready: () => {
              loaded.value = true;
              emit('onDocumentReady');
              fetchAndCacheApplication();
            },
            documentStateChange: (event) => {
              const changed = event?.data;
              if (typeof changed === 'boolean') emit('onDocumentStateChange', changed);
            },
          },
        };

        wpsInstance = SDK.init(initConfig);
        if (!wpsInstance) {
          throw new Error('WPS SDK init 返回空实例');
        }

      } catch (error) {
        console.error('[WPS Editor] Init error:', error);
        sdkError.value = error.message || 'WPS 编辑器初始化失败';
        emit('onError', error);
      }
    };

    // 性能优化：统一获取Application，支持队列等待
    const fetchAndCacheApplication = async () => {
      if (wpsApplication) return wpsApplication;
      if (!wpsInstance) return null;
      
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
        appResolveQueue.forEach(({ resolve }) => resolve(app));
        appResolveQueue = [];
        return app;
      } catch (error) {
        appResolveQueue.forEach(({ reject }) => reject(error));
        appResolveQueue = [];
        return null;
      } finally {
        isAppResolving = false;
      }
    };

    // 对外暴露的 getApplication
    const getApplication = async () => {
      if (wpsApplication) return wpsApplication;
      return fetchAndCacheApplication();
    };

    // 重试初始化
    const retryInit = () => {
      if (wpsInstance) {
        try { wpsInstance.destroy(); } catch {}
        wpsInstance = null;
      }
      wpsApplication = null;
      appResolveQueue = [];
      initEditor();
    };

    // 暴露方法给父组件（Options API 方式：在 return 中暴露）
    // defineExpose({ getApplication, retryInit });  // <-- 这个在 Options API 中不适用

    onMounted(async () => {
      await loadSDK();
      await initEditor();
    });

    onUnmounted(() => {
      if (wpsInstance) {
        try { wpsInstance.destroy(); } catch {}
        wpsInstance = null;
      }
      wpsApplication = null;
    });

    // 监听 contractId 变化
    watch(() => props.contractId, async (newId, oldId) => {
      if (newId && newId !== oldId) {
        loaded.value = false;
        if (wpsInstance) {
          try { wpsInstance.destroy(); } catch {}
          wpsInstance = null;
        }
        wpsApplication = null;
        await loadSDK();
        await initEditor();
      }
    });

    return {
      editorMount,
      loaded,
      sdkError,
      loadingText,
      retryInit,
      getApplication,  // 暴露给父组件
    };
  },
});
</script>
