/**
 * WPS WebOffice 编辑器配置生成器
 * 替代原有的 OnlyOffice buildOnlyOfficeConfig
 */
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const WPS_APP_ID = process.env.WPS_APP_ID || '';
const WPS_TOKEN_SECRET = process.env.WPS_TOKEN_SECRET || process.env.ONLYOFFICE_JWT_SECRET || 'change-me';

/**
 * 生成 WPS WebOffice 前端 SDK init 配置
 * @param {Object} contractRecord - 合同记录
 * @param {string} ext - 文件扩展名
 * @returns {Object} WPS SDK init 配置
 */
const buildWpsEditorConfig = (contractRecord, ext = 'docx') => {
  const isPdf = ext === 'pdf';
  const fileId = String(contractRecord.id || contractRecord.document_key || uuidv4());
  
  // Token: 自定义令牌，WPS 会通过 X-Weboffice-Token 回传
  const tokenPayload = {
    userId: contractRecord.user_id || 1,
    contractId: contractRecord.id,
    documentKey: contractRecord.document_key,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400, // 24h 有效
  };
  const token = jwt.sign(tokenPayload, WPS_TOKEN_SECRET);

  // officeType 根据文件类型确定（WPS SDK 使用单字母码）
  let officeType;
  if (isPdf) {
    officeType = 'f'; // WebOfficeSDK.OfficeType.Pdf
  } else {
    officeType = 'w'; // WebOfficeSDK.OfficeType.Writer
  }

  return {
    appId: WPS_APP_ID,
    fileId: `contract-${contractRecord.id || 'new'}`,
    officeType,
    token,
    // 自定义参数：携带合同业务信息
    customArgs: {
      contract_id: String(contractRecord.id || ''),
      document_key: contractRecord.document_key || '',
    },
    // 通用配置项
    commonOptions: {
      isShowTopArea: true,
      isShowHeader: true,
      isParentFullscreen: false,
      isIframeViewFullscreen: false,
      isBrowserViewFullscreen: false,
    },
    // 文档自定义配置
    wpsOptions: {
      isShowDocMap: true,
      isBestScale: true,
      isShowBottomStatusBar: !isPdf,
    },
  };
};

/**
 * 验证 WPS 回调 Token
 */
const verifyWpsToken = (token) => {
  try {
    return jwt.verify(token, WPS_TOKEN_SECRET);
  } catch {
    return null;
  }
};

module.exports = { buildWpsEditorConfig, verifyWpsToken };
