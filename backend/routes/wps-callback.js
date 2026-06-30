/**
 * WPS WebOffice v3 回调接口
 * 
 * 根据 WPS WebOffice 开放平台回调协议实现：
 * - 文件信息、下载、权限、用户信息
 * - 三阶段保存（prepare → address → complete）
 * - 所有回调接口必须部署在公网
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../database');

const router = express.Router();

// WPS 回调服务配置
const WPS_APP_ID = process.env.WPS_APP_ID || '';
const WPS_APP_SECRET = process.env.WPS_APP_SECRET || '';
// 回调外网基础 URL（WPS 服务器可达），从环境变量读取，或自动推断
const WPS_CALLBACK_BASE = process.env.WPS_CALLBACK_BASE || '';
// 文件上传目录
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// 确保临时上传目录存在
const UPLOAD_TEMP_DIR = path.join(UPLOADS_DIR, '.wps-temp');
if (!fs.existsSync(UPLOAD_TEMP_DIR)) {
  fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
}

// ========== WPS-2 签名验证中间件 ==========
const verifyWpsSignature = (req, res, next) => {
  // TODO: 正式上线后启用 WPS-2 签名验证
  // 签名算法：SHA1(AppSecret + Content-Md5 + Content-Type + Date)
  // Authorization: WPS-2:AppId:SHA1值
  next();
};

// ========== 统一响应格式 ==========
const ok = (data = null) => ({ code: 0, data, message: '' });
const fail = (message, code = 1) => ({ code, data: null, message });

// ========== 辅助：查询合同记录 ==========
const findContract = async (fileId) => {
  // fileId format: "contract-77" — strip prefix to get numeric ID
  const numericId = String(fileId).replace(/^contract-/, '');
  return db('contracts').where({ id: Number(numericId) }).first();
};

const getFileStat = (storagePath) => {
  try {
    const stat = fs.statSync(storagePath);
    return stat.size;
  } catch {
    return 0;
  }
};

// ========== 1. 获取文件信息 ==========
// GET /v3/3rd/files/:file_id
router.get('/v3/3rd/files/:file_id', verifyWpsSignature, async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract) {
      return res.status(404).json(fail('File not found'));
    }
    res.json(ok({
      id: req.params.file_id, // Return full fileId (e.g. "contract-77") to match SDK
      name: contract.original_filename || '未命名文档',
      version: 1,
      size: getFileStat(contract.storage_path),
      create_time: Math.floor(new Date(contract.created_at || Date.now()).getTime() / 1000),
      modify_time: Math.floor(new Date(contract.updated_at || Date.now()).getTime() / 1000),
      creator_id: String(contract.user_id || 1),
      modifier_id: String(contract.user_id || 1),
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] File info error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 2. 获取文件下载地址 ==========
// GET /v3/3rd/files/:file_id/download
router.get('/v3/3rd/files/:file_id/download', verifyWpsSignature, async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract || !contract.storage_path) {
      return res.status(404).json(fail('File not found'));
    }

    // 返回一个直链（raw endpoint 在下方实现）
    const rawUrl = `${WPS_CALLBACK_BASE}/v3/3rd/files/${req.params.file_id}/download/raw`;

    // 计算文件校验和
    let digest = '';
    try {
      const fileBuffer = fs.readFileSync(contract.storage_path);
      digest = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    } catch {}

    res.json(ok({
      url: rawUrl,
      digest: digest || undefined,
      digest_type: digest ? 'sha256' : undefined,
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] Download error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 文件原始内容下载（WPS 内部使用的直链） ==========
router.get('/v3/3rd/files/:file_id/download/raw', async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract || !contract.storage_path) {
      return res.status(404).send('File not found');
    }
    if (!fs.existsSync(contract.storage_path)) {
      return res.status(404).send('File not found on disk');
    }
    const fileName = contract.original_filename || `contract_${contract.id}.docx`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.sendFile(contract.storage_path);
  } catch (error) {
    console.error('[WPS-CALLBACK] Raw download error:', error);
    res.status(500).send('Internal error');
  }
});

// ========== 3. 文档用户权限 ==========
// GET /v3/3rd/files/:file_id/permission
router.get('/v3/3rd/files/:file_id/permission', verifyWpsSignature, async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract) return res.status(404).json(fail('File not found'));

    const ext = String(contract.original_filename || '').toLowerCase();
    const isPdf = ext.endsWith('.pdf');

    res.json(ok({
      // 权限位：1=可读 2=可下载 4=可编辑 8=可打印 16=可评论 32=可分享
      read: 1,
      download: 1,
      edit: isPdf ? 0 : 1,
      print: 1,
      comment: isPdf ? 0 : 1,
      rename: 0,
      copy: 1,
      history: 0, // 暂不提供版本历史回调
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] Permission error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 4. 用户信息 ==========
// GET /v3/3rd/users/:user_id
router.get('/v3/3rd/users/:user_id', verifyWpsSignature, async (req, res) => {
  try {
    const userId = req.params.user_id;
    res.json(ok({
      id: String(userId),
      name: `用户 ${userId}`,
      avatar_url: '',
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] User info error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 5. 三阶段保存 - 准备上传阶段 ==========
// GET /v3/3rd/files/:file_id/upload/prepare
router.get('/v3/3rd/files/:file_id/upload/prepare', verifyWpsSignature, async (req, res) => {
  try {
    res.json(ok({
      digest_types: ['sha256'],
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] Upload prepare error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 6. 三阶段保存 - 获取上传地址 ==========
// POST /v3/3rd/files/:file_id/upload/address
router.post('/v3/3rd/files/:file_id/upload/address', verifyWpsSignature, async (req, res) => {
  try {
    const { name, size, digest, is_manual } = req.body || {};
    const fileId = req.params.file_id;
    const contract = await findContract(fileId);

    // 返回一个 PUT 地址，WPS 会直接上传文件到该地址
    const uploadUrl = `${WPS_CALLBACK_BASE}/v3/3rd/files/${fileId}/upload/raw`;

    res.json(ok({
      url: uploadUrl,
      method: 'PUT',
      headers: {},
      params: {},
      send_back_params: {
        file_id: String(contract?.id || fileId),
        is_manual: String(Boolean(is_manual)),
      },
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] Upload address error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 文件上传接收（WPS PUT 文件内容到此处） ==========
router.put('/v3/3rd/files/:file_id/upload/raw', async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const contract = await findContract(fileId);
    if (!contract || !contract.storage_path) {
      return res.status(404).json(fail('File not found'));
    }

    // 保存上传的文件流到合同存储路径
    const writeStream = fs.createWriteStream(contract.storage_path);
    await new Promise((resolve, reject) => {
      req.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // 更新合同时间戳和文档 key（触发重新加载）
    const { v4: uuidv4 } = require('uuid');
    await db('contracts').where({ id: contract.id }).update({
      document_key: uuidv4(),
      updated_at: db.fn.now(),
    });

    res.status(200).end();
  } catch (error) {
    console.error('[WPS-CALLBACK] Raw upload error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 7. 三阶段保存 - 上传完成 ==========
// POST /v3/3rd/files/:file_id/upload/complete
router.post('/v3/3rd/files/:file_id/upload/complete', verifyWpsSignature, async (req, res) => {
  try {
    const fileId = req.params.file_id;
    // 上传已完成，只需确认
    console.log(`[WPS-CALLBACK] Upload complete for file ${fileId}`);
    res.json(ok({
      upload_result: true,
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] Upload complete error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 8. 回调网关（健康检查） ==========
// GET /v3/3rd/gateway
router.get('/v3/3rd/gateway', (req, res) => {
  res.json(ok({
    status: 'ok',
    timestamp: Date.now(),
  }));
});

// ========== 扩展能力回调 ==========
// POST /v3/3rd/files/:file_id/extend
router.post('/v3/3rd/files/:file_id/extend', verifyWpsSignature, async (req, res) => {
  res.json(ok({ processed: true }));
});

module.exports = router;
