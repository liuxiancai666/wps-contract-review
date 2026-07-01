/**
 * WPS WebOffice 编辑器配置生成器 v2
 * - 增加 refreshToken 回调
 * - 增加 commandBars 工具栏配置
 * - 增加自定义头部按钮（导出报告、返回列表）
 */
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const WPS_APP_ID = process.env.WPS_APP_ID || '';
const WPS_TOKEN_SECRET=process.env.WPS_TOKEN_SECRET || process.env.ONLYOFFICE_JWT_SECRET || 'change-me';

/**
 * 生成 WPS WebOffice 前端 SDK init 配置
 */
const buildWpsEditorConfig = (contractRecord, ext = 'docx', options = {}) => {
  const isPdf = ext === 'pdf';
  const fileId = String(contractRecord.id || contractRecord.document_key || uuidv4());

  // Token: 自定义令牌
  const tokenPayload = {
    userId: contractRecord.user_id || 1,
    contractId: contractRecord.id,
    documentKey: contractRecord.document_key,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400, // 24h
  };
  const token = jwt.sign(tokenPayload, WPS_TOKEN_SECRET);

  const officeType = isPdf ? 'f' : 'w';

  // mode: 'nomal' = 普通模式，'simple' = 简化模式
  // 为保证文档与原始文件100%一致，使用普通模式并禁用不必要的功能
  const config = {
    appId: WPS_APP_ID,
    fileId: `contract-${contractRecord.id || 'new'}`,
    officeType,
    token,
    mode: 'nomal',  // 普通模式，不做额外处理

    customArgs: {
      contract_id: String(contractRecord.id || ''),
      document_key: contractRecord.document_key || '',
    },

    commonOptions: {
      isShowTopArea: true,
      isShowHeader: true,
      isParentFullscreen: false,
      isIframeViewFullscreen: false,
      isBrowserViewFullscreen: false,
    },

    wpsOptions: {
      isShowDocMap: false,
      isBestScale: true,
      isShowBottomStatusBar: !isPdf,
      // 确保文档显示与原始文件一致的关键配置
      isStrictMode: true,           // 严格模式，减少自动转换
      isHideCopyResult: true,       // 隐藏拷贝结果提示
      isRemoveDocumentCalendar: true, // 不显示日历控件
      // 控制文档缩放和布局
      defaultZoomMode: 1,           // 适合页面宽度
      defaultViewMode: 1,           // 页面视图模式
    },

    // 强制使用原始文件模式：确保文档内容与上传时完全一致
    // 不添加任何水印、页眉页脚或其他修饰
    wordOptions: {
      isShowInsDel: false,          // 不显示插入/删除标记
      isShowFormatCode: false,      // 不显示格式代码
      isHideScrollBar: false,
    },

    // 自定义头部按钮
    headers: {
      backBtn: {
        tooltip: '返回',
        subscribe: 'back',
      },
      otherMenuBtn: {
        tooltip: '更多操作',
        items: [
          {
            type: 'custom',
            text: '📄 导出带批注报告',
            subscribe: 'export-annotated',
          },
          {
            type: 'split_line',
          },
          {
            type: 'custom',
            text: '🔍 查看 AI 审查结果',
            subscribe: 'show-review',
          },
          {
            type: 'split_line',
          },
          {
            type: 'custom',
            text: '📋 返回合同列表',
            subscribe: 'back-to-list',
          },
        ],
      },
    },
  };

  // 审查完成后的在线编辑模式：简化 UI
  if (options.afterReview) {
    config.mode = 'simple';
    config.commonOptions.isShowTopArea = false;
    config.commandBars = [
      {
        cmbId: 'ReviewTab', // 审阅
        attributes: { visible: false },
      },
      {
        cmbId: 'InsertTab', // 插入
        attributes: { visible: false },
      },
      {
        cmbId: 'DesignTab', // 设计
        attributes: { visible: false },
      },
      {
        cmbId: 'PageLayoutTab', // 页面布局
        attributes: { visible: false },
      },
      {
        cmbId: 'ReferencesTab', // 引用
        attributes: { visible: false },
      },
      {
        cmbId: 'MailingsTab', // 邮件
        attributes: { visible: false },
      },
    ];
  }

  return config;
};

const verifyWpsToken = (token) => {
  try {
    return jwt.verify(token, WPS_TOKEN_SECRET);
  } catch {
    return null;
  }
};

module.exports = { buildWpsEditorConfig, verifyWpsToken };
