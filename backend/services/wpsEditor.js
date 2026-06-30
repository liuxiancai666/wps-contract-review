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
 * 
 * WPS WebOffice SDK v2.0.7 初始化参数说明：
 * - appId: 应用ID（WPS控制台获取）
 * - fileId: 文档唯一标识（SDK通过此ID + appId 向WPS云服务请求回调）
 * - officeType: 文档类型（w=文字, s=表格, p=演示, f=PDF）
 * - token: 自定义令牌，WPS会通过 X-Weboffice-Token 回传给回调服务器
 * - 注意：不支持 url 参数！WPS云服务根据 appId 自动路由到控制台配置的回调地址
 * - 回调地址必须在 WPS 控制台（https://solution.wps.cn）中配置
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
