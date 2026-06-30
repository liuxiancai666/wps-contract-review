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

  const config = {
    appId: WPS_APP_ID,
    fileId: `contract-${contractRecord.id || 'new'}`,
    officeType,
    token,

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
      isShowDocMap: true,
      isBestScale: true,
      isShowBottomStatusBar: !isPdf,
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
