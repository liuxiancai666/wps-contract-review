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
import { ElMessage } from 'element-plus';
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

    // 简单字符串 hash，用于无 id 时生成书签名
    const hashCode = (str) => {
      let h = 0;
      for (let i = 0; i < str.length; i++) {
        h = Math.imul(31, h) + str.charCodeAt(i) | 0;
      }
      return h;
    };
    
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
        const tokenKey = 'auth_token';
        const authToken = localStorage.getItem(tokenKey) || '';
        const configResp = await fetch(`/api/contracts/${numericId}/wps-config`, {
          headers: {
            'X-User-ID': getUserId() || '',
            ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
          }
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
          // attrAllow: SDK 权限字符串，定义允许的操作（edit=可编辑）
          // 缺少此字段时 SDK 可能默认只读
          attrAllow: ['edit', 'comment', 'download', 'print', 'saveas'],
          // permission JS 对象：控制 UI 操作按钮状态（edit=编辑按钮可用）
          permission: {
            edit: true,
            comment: true,
            download: true,
            print: true,
          },
          commonOptions: {
            isShowTopArea: showToolbar,  // 审查结果页显示工具栏
            isShowHeader: showToolbar,   // 与星法 SDK 一致：顶部标题区
            isBrowserViewFullscreen: false,
            isIframeViewFullscreen: false,
            acceptVisualViewportResizeEvent: true,  // 与星法 SDK 一致
          },
          wpsOptions: {
            isShowDocMap: false,    // 审查页不需要目录大纲
            isBestScale: true,
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
    // 升级版：全角→半角 + 零宽字符清理 + Word 特殊字符
    const normalizeText = (text) => {
      if (!text) return '';
      let t = String(text);
      // 零宽字符、不间断空格
      t = t.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '');
      // 全角标点 → 半角（中文文档常见全角逗号句号）
      t = t.replace(/[""]/g, '"').replace(/['']/g, "'");
      t = t.replace(/[：]/g, ':').replace(/[，]/g, ',');
      t = t.replace(/[。]/g, '.').replace(/[、]/g, ',');
      t = t.replace(/[；]/g, ';').replace(/[！]/g, '!');
      t = t.replace(/[？]/g, '?');
      // 连续空白合并
      t = t.replace(/\s+/g, ' ');
      // Word 换行/制表符（Find API 专用）
      t = t.replace(/[\r\n\v]+/g, '^p');
      t = t.replace(/\t/g, '^t');
      t = t.replace(/\u0007/g, '');
      t = t.replace(/[\x00-\x08\x0C-\x1F\x7F]/g, '');
      return t.trim();
    };

    // =============================================
    // 原文定位核心：findAllMatchPositions
    // 使用 sel.Find.Execute 遍历全文，返回所有匹配位置
    // WebOffice 返回 [{ found, pos, len, wrap }]
    // =============================================
    const findAllMatchPositions = async (originalText) => {
      const app = await getApplication();
      if (!app) { console.warn('[WPS] findAll: no app'); return []; }
      const doc = app.ActiveDocument;
      if (!doc) { console.warn('[WPS] findAll: no doc'); return []; }

      const normText = normalizeText(originalText);
      if (!normText || normText.length < 2) return [];
      console.log('[WPS] findAll:', normText.substring(0, 40));

      const positions = [];

      // 方案A: sel.Find.Execute 遍历（WebOffice 中最可靠）
      try {
        const sel = doc.ActiveWindow.Selection;
        await sel.SetRange(0, 0);
        let iter = 0;
        const MAX_LOOPS = 200; // 防止死循环

        while (iter < MAX_LOOPS) {
          iter++;
          // Execute(matchText, wrap) — wrap=false 表示不环绕搜索
          // WebOffice 返回 [{ found: bool, pos: int, len: int }]
          let result = await sel.Find.Execute(normText, false);

          // 标准化返回值：可能是 [{...}], [bool], bool
          let found = false, pos = -1, len = 0;
          if (Array.isArray(result) && result.length > 0) {
            found = !!result[0].found;
            pos = Number(result[0].pos) || -1;
            len = Number(result[0].len) || 0;
          } else if (typeof result === 'boolean') {
            found = result;
          }

          if (!found || pos < 0) break;

          positions.push([pos, pos + len]);
          console.log(`[WPS] findAll match ${positions.length}: pos=${pos} len=${len}`);

          // 移动选区到匹配之后，准备下一次搜索
          if (iter < MAX_LOOPS) {
            try {
              await sel.SetRange(pos + len, pos + len);
            } catch {
              break; // 无法移动就停止
            }
          }
        }
        console.log(`[WPS] findAll: ${positions.length} matches found`);
      } catch (e) {
        console.warn('[WPS] findAll sel.Find failed:', e.message);
      }

      // 方案B: 如果方案A失败，用 doc.Range.Find 搜索短文本片断
      if (positions.length === 0 && normText.length > 10) {
        try {
          // 截取有辨识度的片段（前30字符，跳过开头常用词）
          const shortText = normText.length > 30
            ? normText.substring(10, 40).replace(/[，。、；：""'']$/, '').trim()
            : normText.replace(/[，。、；：""'']$/, '').trim();

          if (shortText.length >= 4) {
            // doc.Content.End = 文档末尾位置（Word API）
            const docEnd = doc.Content?.End ?? doc.Content?.Range?.End ?? 999999;
            const searchRange = doc.Range(0, docEnd);
            const findObj = searchRange.Find;

            findObj.Text = shortText;
            findObj.Forward = true;
            findObj.Wrap = 0; // wdFindStop=0

            let loop2 = 0;
            while (loop2 < 50) {
              loop2++;
              const r = await findObj.Execute();
              let found = false, pos = -1, len2 = 0;
              if (Array.isArray(r) && r.length > 0) {
                found = !!r[0].found;
                pos = Number(r[0].pos) || -1;
                len2 = Number(r[0].len) || 0;
              } else if (typeof r === 'boolean') {
                found = r;
              }

              if (!found || pos < 0) break;
              positions.push([pos, pos + len2]);

              // 移动到匹配之后
              try { await searchRange.SetRange(pos + len2, pos + len2); } catch { break; }
              findObj.Text = shortText; // 重设搜索文本
            }
            console.log(`[WPS] findAll Range.Find: ${positions.length} matches`);
          }
        } catch (e) {
          console.warn('[WPS] findAll Range.Find failed:', e.message);
        }
      }

      // 方案C: JS全文匹配（终极fallback，来自trae分支思路）
      // 当 WPS Find API 无法找到时，用 JS 在完整文档文本中搜索
      if (positions.length === 0) {
        try {
          const fullDocContent = await doc.Content;
          const fullText = String(await fullDocContent?.Text || '');
          if (fullText && normText) {
            // 归一化后匹配
            const normalizeForMatch = (s) => s
              .replace(/\s+/g, '').replace(/[""]/g, '"')
              .replace(/['']/g, "'").replace(/[：]/g, ':')
              .replace(/[，]/g, ',').replace(/[。]/g, '.')
              .replace(/[、]/g, ',').replace(/[；]/g, ';')
              .replace(/[！]/g, '!').replace(/[？]/g, '?');
            const normFull = normalizeForMatch(fullText);
            const idx = normFull.indexOf(normalizeForMatch(normText));
            if (idx >= 0) {
              // 将归一化位置映射回原文位置
              let rawStart = 0, normCount = 0;
              while (rawStart < fullText.length && normCount < idx) {
                if (!/\s/.test(fullText[rawStart])) normCount++;
                rawStart++;
              }
              let rawEnd = rawStart, matchLen = 0;
              while (rawEnd < fullText.length && matchLen < normalizeForMatch(normText).length) {
                if (!/\s/.test(fullText[rawEnd])) matchLen++;
                rawEnd++;
              }
              positions.push([rawStart, rawEnd]);
              console.log(`[WPS] findAll JS-match: pos=[${rawStart},${rawEnd}], text="${fullText.substring(rawStart, rawEnd).substring(0,30)}"`);
            }
          }
        } catch (e) {
          console.warn('[WPS] findAll JS-match failed:', e.message);
        }
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
                const range = doc.Range(positions[0][0], positions[0][1]);
                await doc.Bookmarks.Add({ Name: bookmarkName, Range: range });
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
      if (!app || !app.ActiveDocument) { console.warn('[WPS] batchCreateRiskBookmarks: no app'); return; }
      const doc = app.ActiveDocument;
      console.log('[WPS] batchCreateRiskBookmarks called with', riskItems?.length, 'items');
      try {
        const existingBookmarks = (await doc.Bookmarks.Json()).map(b => b.name);
        console.log('[WPS] existing bookmarks:', existingBookmarks);
        for (let i = 0; i < riskItems.length; i++) {
          const item = riskItems[i];
          const itemId = item.id || i;
          const titleBookmarkName = `risk_title_${itemId}`;
          const editBookmarkName = `risk_edit_${itemId}`;
          console.log(`[WPS] processing item ${i}: filtered_content=`, item.filtered_content ? item.filtered_content.substring(0, 30) : 'EMPTY');
          try {
            if (item.filtered_content) {
              if (existingBookmarks.includes(titleBookmarkName)) {
                item.titleBookmark = titleBookmarkName;
                console.log(`[WPS] item ${i}: bookmark already exists, using ${titleBookmarkName}`);
              } else {
                const positions = await findAllMatchPositions(item.filtered_content);
                console.log(`[WPS] item ${i}: positions=`, positions);
                if (positions && positions.length > 0) {
                  // 创建标题书签
                  const range = doc.Range(positions[0][0], positions[0][1]);
                  await doc.Bookmarks.Add({ Name: titleBookmarkName, Range: range });
                  // 创建编辑书签（同一位置）
                  await doc.Bookmarks.Add({ Name: editBookmarkName, Range: range });
                  item.titleBookmark = titleBookmarkName;
                  item.editBookmark = editBookmarkName;
                  console.log(`[WPS] item ${i}: created bookmarks ${titleBookmarkName} and ${editBookmarkName}`);
                } else {
                  console.warn(`[WPS] item ${i}: no positions found, skipping bookmark creation`);
                }
              }
            } else {
              console.warn(`[WPS] item ${i}: filtered_content is empty, skipping`);
            }
          } catch (e) {
            console.warn(`[WPS] batchCreateRiskBookmarks item ${i} failed:`, e.message);
          }
        }
        console.log(`[WPS] batchCreateRiskBookmarks: ${riskItems.length} items processed`);
      } catch (error) {
        console.error('[WPS] batchCreateRiskBookmarks error:', error.message);
      }
    };

    // 定位原文（书签导航）
    // 定位原文书签（支持按需创建书签）
    // 传入 item 时：如果 bookmarkName 为空但 item 有 filtered_content，自动创建书签后导航
    const gotoBookmark = async (bookmarkName, item) => {
      const app = await getApplication();
      if (!app) {
        ElMessage.warning('WPS 文档未就绪，请稍候再试');
        return false;
      }
      const doc = app.ActiveDocument;
      let targetBookmark = bookmarkName;

      // 如果没有 bookmarkName 但有 item.filtered_content，按需创建书签
      if (!targetBookmark && item?.filtered_content) {
        const itemId = item.id || Math.abs(hashCode(String(item.filtered_content)));
        targetBookmark = `risk_title_${itemId}`;
        try {
          const existing = (await doc.Bookmarks.Json()).map(b => b.name);
          if (!existing.includes(targetBookmark)) {
            const positions = await findAllMatchPositions(item.filtered_content);
            if (positions?.length > 0) {
              const range = doc.Range(positions[0][0], positions[0][1]);
              await doc.Bookmarks.Add({ Name: targetBookmark, Range: range });
              // 同步创建编辑书签（与 risk_title_ 同位置，供批注和修订使用）
              const editBookmark = `risk_edit_${itemId}`;
              if (!existing.includes(editBookmark)) {
                await doc.Bookmarks.Add({ Name: editBookmark, Range: range });
              }
              // 更新 item 上的书签名称，供后续批注/修订直接使用
              if (item) { item.titleBookmark = targetBookmark; item.editBookmark = editBookmark; }
              ElMessage.success('已创建书签并定位');
            } else {
              ElMessage.warning('未在文档中找到「' + item.filtered_content.substring(0, 15) + '...」，请手动定位');
              return false;
            }
          }
        } catch (e) {
          ElMessage.warning('书签创建失败：' + e.message);
          return false;
        }
      }

      if (!targetBookmark) {
        ElMessage.warning('无原文信息，无法定位');
        return false;
      }

      try {
        // 使用 Selection.GoTo 定位书签（Word API 标准方式）
        // WdGoToItem.wdGoToBookmark = -1
        await doc.ActiveWindow.Selection.GoTo({
          What: app.Enum.WdGoToItem.wdGoToBookmark,
          Name: targetBookmark,
        });
        return true;
      } catch (error) {
        console.error('[WPS] gotoBookmark error:', error.message);
        // 抛出异常让调用方 catch 住，以便触发书签重建逻辑
        throw new Error('书签定位失败：' + error.message);
      }
    };

    // 添加审查批注（支持按需创建书签）
    // 优先使用 editBookmark；无 editBookmark 但有 actionData.target_text 时按需创建
    const addReviewCommentByBookmarkWps = async (editBookmark, actionData, itemId, item) => {
      const app = await getApplication();
      if (!app) {
        ElMessage.warning('WPS 文档未就绪，请稍候再试');
        return;
      }
      const doc = app.ActiveDocument;
      let targetBookmark = editBookmark;

      // 无书签但有原文文本，按需创建
      if (!targetBookmark && (actionData?.target_text || item?.filtered_content)) {
        const searchText = item?.filtered_content || actionData?.target_text || '';
        const iId = item?.id || itemId || Math.abs(hashCode(String(searchText)));
        targetBookmark = `risk_edit_${iId}`;
        try {
          const existing = (await doc.Bookmarks.Json()).map(b => b.name);
          if (!existing.includes(targetBookmark)) {
            const positions = await findAllMatchPositions(searchText);
            if (positions?.length > 0) {
              const range = doc.Range(positions[0][0], positions[0][1]);
              await doc.Bookmarks.Add({ Name: targetBookmark, Range: range });
              // 同步创建标题书签（定位用）
              const titleBm = `risk_title_${iId}`;
              if (!existing.includes(titleBm)) {
                await doc.Bookmarks.Add({ Name: titleBm, Range: range });
              }
              if (item) { item.titleBookmark = titleBm; item.editBookmark = targetBookmark; }
              ElMessage.success('已创建批注书签');
            } else {
              ElMessage.warning('未在文档中找到原文，无法批注');
              return;
            }
          }
        } catch (e) {
          ElMessage.error('书签创建失败：' + e.message);
          return;
        }
      }

      if (!targetBookmark) {
        ElMessage.warning('无原文信息，请先定位原文后再添加批注');
        return;
      }

      try {
        await doc.ActiveWindow.Selection.GoTo({
          What: app.Enum.WdGoToItem.wdGoToBookmark,
          Name: targetBookmark,
        });
        // 构建批注内容
        let commentText = '';
        if (actionData) {
          switch (actionData.action) {
            case 'replace':
              commentText = `【AI审查建议】将"${actionData.target_text}"${actionData.actionText || '修改为'}"${actionData.new_text}"`;
              break;
            case 'insert_before':
              commentText = `【AI审查建议】在"${actionData.target_text}"之前插入"${actionData.new_text}"`;
              break;
            case 'insert_after':
              commentText = `【AI审查建议】在"${actionData.target_text}"之后插入"${actionData.new_text}"`;
              break;
            case 'delete':
              commentText = `【AI审查建议】删除"${actionData.target_text}"`;
              break;
            default:
              commentText = `【AI审查建议】${actionData.target_text ? '针对该条款' : JSON.stringify(actionData)}`;
          }
        }
        const selection = doc.ActiveWindow.Selection;
        await doc.Comments.Add(selection.Range, commentText);
        ElMessage.success('批注添加成功');
      } catch (error) {
        console.error('[WPS] addReviewCommentByBookmarkWps error:', error.message);
        ElMessage.error('批注添加失败：' + (error.message || '未知错误'));
      }
    };

    // 通过书签替换文本（支持按需创建书签）
    const adjustReplaceByBookmarkWps = async (editBookmark, actionData, itemId, item) => {
      const app = await getApplication();
      if (!app) {
        ElMessage.warning('WPS 文档未就绪，请稍候再试');
        return;
      }
      const doc = app.ActiveDocument;
      let targetBookmark = editBookmark;

      // 无书签但有原文文本，按需创建
      if (!targetBookmark && (actionData?.target_text || item?.filtered_content)) {
        const searchText = item?.filtered_content || actionData?.target_text || '';
        const iId = item?.id || itemId || Math.abs(hashCode(String(searchText)));
        targetBookmark = `risk_edit_${iId}`;
        try {
          const existing = (await doc.Bookmarks.Json()).map(b => b.name);
          if (!existing.includes(targetBookmark)) {
            const positions = await findAllMatchPositions(searchText);
            if (positions?.length > 0) {
              const range = doc.Range(positions[0][0], positions[0][1]);
              await doc.Bookmarks.Add({ Name: targetBookmark, Range: range });
              const titleBm = `risk_title_${iId}`;
              if (!existing.includes(titleBm)) {
                await doc.Bookmarks.Add({ Name: titleBm, Range: range });
              }
              if (item) { item.titleBookmark = titleBm; item.editBookmark = targetBookmark; }
              ElMessage.success('已创建修订书签');
            } else {
              ElMessage.warning('未在文档中找到原文，无法修订');
              return;
            }
          }
        } catch (e) {
          ElMessage.error('书签创建失败：' + e.message);
          return;
        }
      }

      if (!targetBookmark) {
        ElMessage.warning('无原文信息，请先定位原文后再调整');
        return;
      }

      try {
        const bookmarkRange = await doc.Bookmarks.Item(targetBookmark);
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
        await doc.Bookmarks.ReplaceBookmark([{ name: targetBookmark, type: 'text', value: newText }]);
        await doc.ActiveWindow.Selection.GoTo({
          What: app.Enum.WdGoToItem.wdGoToBookmark,
          Name: targetBookmark,
        });
        ElMessage.success('文本已调整');
      } catch (error) {
        console.error('[WPS] adjustReplaceByBookmarkWps error:', error.message);
        ElMessage.error('文本调整失败：' + (error.message || '未知错误'));
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
      // 批注跳转 API（GoToComment，跳转到文档中指定批注位置）
      goToComment: async (commentId) => {
        const app = await getApplication();
        if (!app) { ElMessage.warning('WPS 文档未就绪，请稍候再试'); return false; }
        try {
          await app.ActiveDocument.Comments.GoToComment({ CommentId: commentId });
          return true;
        } catch (e) {
          ElMessage.warning('无法跳转到指定批注：' + e.message);
          return false;
        }
      },
      // 命令栏控制
      setCommandBars: (bars) => wpsInstance?.setCommandBars(bars),
      executeCommandBar: (cmbId) => wpsInstance?.executeCommandBar(cmbId),
      getWpsInstance: () => wpsInstance,
      // SDK 级别导航（比 Selection.GoTo 更可靠）
      wpsGoTo: (bookmarkName) => wpsInstance?.GoTo?.(bookmarkName),
    };
  },
});
</script>
