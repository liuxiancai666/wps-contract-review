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
        const sdkMode = wpsConfig.mode || 'simple';
        // nomal（typo for normal 有审查结果）| simple | embed
        // 审查结果页需要工具栏：nomal 模式显示顶部导航栏
        const showToolbar = (sdkMode === 'nomal' || sdkMode === 'edit');
        const initConfig = {
          officeType: wpsConfig.fileSuffix || 'w',
          appId: wpsConfig.appId,
          endpoint: wpsConfig.endpoint || 'https://o.wpsgo.com',
          fileId: wpsConfig.fileId || `contract-${numericId}`,
          mode: sdkMode,
          mount: '#file-views-wps',
          // 不传 callbackUrl：SDK v2 通过 token 直连 WPS 服务器，不需要回调
          token: sdkToken,
          refreshToken: getRefreshToken,
          commonOptions: {
            isShowTopArea: showToolbar,  // 审查结果页显示工具栏
            isShowHeader: showToolbar,   // 与星法 SDK 一致：顶部标题区
            isBrowserViewFullscreen: false,
            isIframeViewFullscreen: false,
            acceptVisualViewportResizeEvent: true,  // 与星法 SDK 一致
          },
          wordOptions: {
            isShowDocMap: false,    // 审查页不需要目录大纲
            isBestScale: false,
            isFullscreen: false,
          },
          // commandBars 在 init 时传给 WPS，控制命令栏显示/隐藏
          // 这里只隐藏 FloatQuickHelp（帮助浮窗），其余工具栏按钮保持默认
          commandBars: [
            { cmbId: 'FloatQuickHelp', attributes: { visible: false, enable: false } },
          ],
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
        wpsApplication = null;
        appResolveQueue = [];
      }
      initEditor();
    };

    // 保存文档（SDK v2.0.7 原生 save 方法）
    // 对应星法2.0的"保存文档"操作，内部通过 /v3/3rd/notify 回调通知后端
    const save = async () => {
      if (!wpsInstance) return;
      try {
        if (typeof wpsInstance.save === 'function') {
          await wpsInstance.save();
          console.log('[WPS] Document saved via SDK save()');
        } else {
          console.warn('[WPS] wpsInstance.save() not available');
        }
      } catch (error) {
        console.error('[WPS] save() error:', error);
      }
    };

    // 更新 token（token 即将过期时由后端刷新后调用此方法）
    const setToken = async (tokenData) => {
      if (!wpsInstance) return;
      try {
        if (typeof wpsInstance.setToken === 'function') {
          await wpsInstance.setToken({
            token: tokenData.token || tokenData,
            timeout: tokenData.timeout || 600 * 1000,
            hasRefreshTokenConfig: Boolean(wpsInstance.tokenData),
          });
          console.log('[WPS] Token updated via setToken()');
        } else {
          console.warn('[WPS] wpsInstance.setToken() not available');
        }
      } catch (error) {
        console.error('[WPS] setToken() error:', error);
      }
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

    // ============================================================
    // 星法2.0 书签定位技术实现
    // ============================================================

    // 规范化文本（用于 WPS Find API 匹配）
    const normalizeText = (text) => {
      if (!text) return '';
      let t = String(text);
      t = t.replace(/[\r\n\v]+/g, '^p');  // 换行 → ^p
      t = t.replace(/\t/g, '^t');          // 制表符 → ^t
      t = t.replace(/\u0007/g, '');        // 移除 bell 字符
      t = t.replace(/[\x00-\x08\x0C-\x1F\x7F]/g, ''); // 移除控制字符
      return t;
    };

    // 查找所有匹配的原始位置（使用 WPS Find API）
    const findAllMatchPositions = async (originalText) => {
      const app = await getApplication();
      if (!app || !app.ActiveDocument) return [];
      const positions = [];
      try {
        const doc = app.ActiveDocument;
        await doc.Range.SetRange(0, 0);
        const normText = normalizeText(originalText);
        const findResults = await doc.Find.Execute(normText, false);
        if (!Array.isArray(findResults) || !findResults.length) return positions;
        for (const result of findResults) {
          const startPos = await doc.Range.SetRange(result.pos, result.pos + result.len);
          const start = await startPos.Start;
          const end = await startPos.End;
          positions.push([start, end]);
        }
      } catch (error) {
        console.error('[WPS] findAllMatchPositions error:', error);
      }
      return positions;
    };

    // 批量创建纠错书签（fixItems = [{sceUuid, original_text, ...}]
    const batchCreateFixBookmarks = async (fixItems) => {
      const app = await getApplication();
      if (!app || !app.ActiveDocument) return;
      const doc = app.ActiveDocument;
      try {
        // 获取现有书签列表
        const existingBookmarks = (await doc.Bookmarks.Json()).map(b => b.name);
        for (let i = 0; i < fixItems.length; i++) {
          const item = fixItems[i];
          if (!item.original_text) continue;
          try {
            const positions = await findAllMatchPositions(item.original_text);
            if (positions && positions.length > 0) {
              const bookmarkName = `fix_${item.sceUuid || i}`;
              if (!existingBookmarks.includes(bookmarkName)) {
                await doc.Bookmarks.Add({ Name: bookmarkName, Range: { Start: positions[0][0], End: positions[0][1] } });
              }
              item.titleBookmark = bookmarkName;
            }
          } catch (e) {
            console.warn(`[WPS] batchCreateFixBookmarks item ${i} failed:`, e.message);
          }
        }
        console.log(`[WPS] batchCreateFixBookmarks: ${fixItems.length} items processed`);
      } catch (error) {
        console.error('[WPS] batchCreateFixBookmarks error:', error);
      }
    };

    // 批量创建风险书签（riskItems = [{id, filtered_content, ...}]
    const batchCreateRiskBookmarks = async (riskItems) => {
      const app = await getApplication();
      if (!app || !app.ActiveDocument) return;
      const doc = app.ActiveDocument;
      console.log('[WPS] batchCreateRiskBookmarks called with', riskItems?.length, 'items');
      try {
        const existingBookmarks = (await doc.Bookmarks.Json()).map(b => b.name);
        for (let i = 0; i < riskItems.length; i++) {
          const item = riskItems[i];
          const itemId = item.id || i;
          const titleBookmarkName = `risk_title_${itemId}`;
          const editBookmarkName = `risk_edit_${itemId}`;
          try {
            if (item.filtered_content) {
              if (existingBookmarks.includes(titleBookmarkName)) {
                item.titleBookmark = titleBookmarkName;
              } else {
                const positions = await findAllMatchPositions(item.filtered_content);
                if (positions && positions.length > 0) {
                  // 创建标题书签
                  await doc.Bookmarks.Add({ Name: titleBookmarkName, Range: { Start: positions[0][0], End: positions[0][1] } });
                  // 创建编辑书签（同一位置）
                  await doc.Bookmarks.Add({ Name: editBookmarkName, Range: { Start: positions[0][0], End: positions[0][1] } });
                  item.titleBookmark = titleBookmarkName;
                  item.editBookmark = editBookmarkName;
                }
              }
            }
          } catch (e) {
            console.warn(`[WPS] batchCreateRiskBookmarks item ${i} failed:`, e.message);
          }
        }
        console.log(`[WPS] batchCreateRiskBookmarks: ${riskItems.length} items processed`);
      } catch (error) {
        console.error('[WPS] batchCreateRiskBookmarks error:', error);
      }
    };

    // 定位原文（书签导航）
    const gotoBookmark = async (bookmarkName) => {
      if (!bookmarkName) {
        console.warn('[WPS] gotoBookmark: bookmarkName is empty');
        return;
      }
      const app = await getApplication();
      if (!app) return;
      try {
        await app.ActiveDocument.ActiveWindow.Selection.GoTo({
          What: app.Enum.WdGoToItem.wdGoToBookmark,
          Name: bookmarkName,
        });
        console.log('[WPS] gotoBookmark:', bookmarkName);
      } catch (error) {
        console.error('[WPS] gotoBookmark error:', error.message);
      }
    };

    // 添加审查批注（通过书签）
    const addReviewCommentByBookmarkWps = async (editBookmark, actionData, itemId) => {
      if (!editBookmark) {
        console.warn('[WPS] addReviewCommentByBookmarkWps: editBookmark is empty');
        return;
      }
      const app = await getApplication();
      if (!app) return;
      try {
        // 定位到书签
        await app.ActiveDocument.ActiveWindow.Selection.GoTo({
          What: app.Enum.WdGoToItem.wdGoToBookmark,
          Which: app.Enum.WdGoToDirection.wdGoToAbsolute,
          Name: editBookmark,
        });
        // 构建批注内容
        let commentText = '';
        if (actionData) {
          switch (actionData.action) {
            case 'replace':
              commentText = `【AI审查建议】将"${actionData.target_text}"${actionData.actionText}为"${actionData.new_text}"`;
              break;
            case 'insert_before':
              commentText = `【AI审查建议】在"${actionData.target_text}"起始位置之前插入"${actionData.new_text}"`;
              break;
            case 'insert_after':
              commentText = `【AI审查建议】在"${actionData.target_text}"结束位置之后插入"${actionData.new_text}"`;
              break;
            case 'delete':
              commentText = `【AI审查建议】删除"${actionData.target_text}"`;
              break;
            default:
              commentText = `【AI审查建议】${JSON.stringify(actionData)}`;
          }
        }
        // 添加批注
        const selection = app.ActiveDocument.ActiveWindow.Selection;
        await app.ActiveDocument.Comments.Add(selection.Range, commentText);
        console.log('[WPS] addReviewCommentByBookmarkWps:', editBookmark, commentText.substring(0, 50));
      } catch (error) {
        console.error('[WPS] addReviewCommentByBookmarkWps error:', error.message);
      }
    };

    // 通过书签替换文本（保留书签）
    const adjustReplaceByBookmarkWps = async (editBookmark, actionData, itemId) => {
      if (!editBookmark) {
        console.warn('[WPS] adjustReplaceByBookmarkWps: editBookmark is empty');
        return;
      }
      const app = await getApplication();
      if (!app) return;
      try {
        const doc = app.ActiveDocument;
        const bookmarkRange = await doc.Bookmarks.Item(editBookmark);
        const currentText = await bookmarkRange.Range.Text;
        let newText = '';
        if (actionData) {
          switch (actionData.action) {
            case 'replace': newText = actionData.new_text || ''; break;
            case 'insert_before': newText = (actionData.new_text || '') + currentText; break;
            case 'insert_after': newText = currentText + (actionData.new_text || ''); break;
            case 'delete': newText = ''; break;
            default: newText = actionData.new_text || currentText;
          }
        }
        await doc.Bookmarks.ReplaceBookmark([{ name: editBookmark, type: 'text', value: newText }]);
        await gotoBookmark(editBookmark);
        console.log('[WPS] adjustReplaceByBookmarkWps:', editBookmark, '→', newText.substring(0, 30));
      } catch (error) {
        console.error('[WPS] adjustReplaceByBookmarkWps error:', error.message);
      }
    };

    // ============================================================
    // 对外暴露的方法（供父组件通过 ref 调用）
    // ============================================================
    return {
      editorMount,
      loaded,
      sdkError,
      loadingText,
      retryInit,
      getApplication,
      save,
      setToken,
      // 星法2.0 书签 API
      batchCreateFixBookmarks,
      batchCreateRiskBookmarks,
      gotoBookmark,
      addReviewCommentByBookmarkWps,
      adjustReplaceByBookmarkWps,
      findAllMatchPositions,
      normalizeText,
      // 命令栏控制
      setCommandBars: (bars) => wpsInstance?.setCommandBars(bars),
      executeCommandBar: (cmbId) => wpsInstance?.executeCommandBar(cmbId),
      getWpsInstance: () => wpsInstance,
    };
  },
});
</script>
