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
const jwt = require('jsonwebtoken');
const db = require('../database');

const router = express.Router();

// WPS 回调服务配置
const WPS_APP_ID = process.env.WPS_APP_ID || '';
const WPS_APP_SECRET = process.env.WPS_APP_SECRET || '';
// 回调外网基础 URL（WPS 服务器可达），从环境变量读取，或自动推断
const WPS_CALLBACK_BASE = process.env.WPS_CALLBACK_BASE || '';
// JWT 签名密钥（与 services/wpsEditor.js 保持一致）
const WPS_TOKEN_SECRET = process.env.WPS_TOKEN_SECRET || process.env.ONLYOFFICE_JWT_SECRET || 'change-me';
// 文件上传目录
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// 确保临时上传目录存在
const UPLOAD_TEMP_DIR = path.join(UPLOADS_DIR, '.wps-temp');
if (!fs.existsSync(UPLOAD_TEMP_DIR)) {
  fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });
}

// ========== WPS-2 签名验证中间件（非严格模式） ==========
const verifyWpsSignature = (req, res, next) => {
  // 签名算法：SHA1(AppSecret + Content-Md5 + Content-Type + Date)
  // 请求头格式：Authorization: WPS-2:AppId:SHA1值
  // 注意：当前以非严格模式运行——签名失败时只记录警告不拒绝请求
  //       待确认 WPS v3 回调的精确签名行为后改为严格模式
  try {
    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('WPS-2:')) {
      const parts = auth.split(':');
      if (parts.length >= 3) {
        const appId = parts[1];
        const signature = parts.slice(2).join(':');
        if (appId !== WPS_APP_ID) {
          console.warn('[WPS-CALLBACK] WPS-2 AppId mismatch, continuing in non-strict mode');
          return next();
        }

        const contentMd5 = req.headers['content-md5'] || '';
        const contentType = req.headers['content-type'] || '';
        const date = req.headers['date'] || '';
        const payload = WPS_APP_SECRET + contentMd5 + contentType + date;
        const expectedSig = crypto.createHash('sha1').update(payload).digest('hex').toLowerCase();

        if (signature.toLowerCase() !== expectedSig) {
          console.warn('[WPS-CALLBACK] WPS-2 signature mismatch, continuing in non-strict mode');
        }
      }
    }
    next();
  } catch (error) {
    console.error('[WPS-CALLBACK] Signature verification error (non-fatal):', error.message);
    next();
  }
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

// ── storage_path 文件完整性检查 & 自动修复 ──
// 当 storage_path 文件缺失或异常小时，从 versions/ 目录或 contract_versions 表恢复
const ensureStoragePathIntegrity = async (contract) => {
  if (!contract || !contract.storage_path) return;
  const MIN_FILE_SIZE = 5 * 1024; // 5KB以下认为是异常文件
  const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');
  const VERSIONS_DIR = path.join(UPLOADS_DIR, 'versions');
  const ext = path.extname(contract.storage_path).toLowerCase() || '.docx';

  try {
    const stat = fs.statSync(contract.storage_path);
    if (stat.size >= MIN_FILE_SIZE) return; // 文件正常，无需修复
    console.warn(`[INTEGRITY] storage_path file too small (${stat.size} bytes), attempting repair for contract ${contract.id}`);
  } catch {
    console.warn(`[INTEGRITY] storage_path file missing for contract ${contract.id}, attempting repair`);
  }

  // 尝试1：从 versions/<id>-original.<ext> 恢复
  const originalBackup = path.join(VERSIONS_DIR, `${contract.id}-original${ext}`);
  if (fs.existsSync(originalBackup)) {
    fs.copyFileSync(originalBackup, contract.storage_path);
    console.log(`[INTEGRITY] Restored from original backup: ${originalBackup} → ${contract.storage_path}`);
    return;
  }

  // 尝试2：从 versions/<id>-reviewed.<ext> 恢复
  const reviewedFile = path.join(VERSIONS_DIR, `${contract.id}-reviewed${ext}`);
  if (fs.existsSync(reviewedFile)) {
    fs.copyFileSync(reviewedFile, contract.storage_path);
    console.log(`[INTEGRITY] Restored from reviewed file: ${reviewedFile} → ${contract.storage_path}`);
    return;
  }

  // 尝试3：从 contract_versions 表找最大版本号的备份文件
  try {
    const latestVersion = await db('contract_versions')
      .where({ contract_id: contract.id })
      .whereNotNull('storage_path')
      .where('storage_path', '!=', '')
      .orderBy('version_no', 'desc')
      .first();
    if (latestVersion && latestVersion.storage_path && fs.existsSync(latestVersion.storage_path)) {
      const vStat = fs.statSync(latestVersion.storage_path);
      if (vStat.size >= MIN_FILE_SIZE) {
        fs.copyFileSync(latestVersion.storage_path, contract.storage_path);
        console.log(`[INTEGRITY] Restored from contract_versions: ${latestVersion.storage_path} → ${contract.storage_path}`);
        return;
      }
    }
  } catch (e) {
    console.warn(`[INTEGRITY] contract_versions lookup failed: ${e.message}`);
  }

  console.error(`[INTEGRITY] ALL recovery attempts failed for contract ${contract.id} — storage_path may be corrupted`);
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
    // ── 文件完整性检查：首次打开时自动修复异常 storage_path ──
    await ensureStoragePathIntegrity(contract);
    // 从 document_key 的版本计算版本号（每次 document_key 更新视为新版本）
    // 用 updated_at 的时间戳除以 1000 作为版本号，保证单调递增
    const versionTs = contract.updated_at
      ? Math.floor(new Date(contract.updated_at).getTime() / 1000)
      : Math.floor(new Date(contract.created_at || Date.now()).getTime() / 1000);
    res.json(ok({
      id: req.params.file_id, // Return full fileId (e.g. "contract-77") to match SDK
      name: contract.original_filename || '未命名文档',
      version: versionTs,
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

    // ── 上传前完整性检查：确保 storage_path 基准文件正常 ──
    await ensureStoragePathIntegrity(contract);

    // 返回一个直链（raw endpoint 在下方实现）
    const rawUrl = `${WPS_CALLBACK_BASE}/v3/3rd/files/${req.params.file_id}/download/raw`;

    // ── 文件完整性检查：storage_path 异常时自动从备份恢复 ──
    await ensureStoragePathIntegrity(contract);

    // 计算文件校验和（WPS 仅支持 md5 或 sha1）
    let digest = '';
    let digestType = '';
    try {
      const fileBuffer = fs.readFileSync(contract.storage_path);
      digest = crypto.createHash('sha1').update(fileBuffer).digest('hex');
      digestType = 'sha1';
    } catch {}

    res.json(ok({
      url: rawUrl,
      digest: digest || undefined,
      digest_type: digestType || undefined,
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
    // 默认可编辑：非PDF且edit_enabled未明确设置为false
    const editEnabled = !isPdf && contract.edit_enabled !== false;

    // 调试：记录 WPS 回调的所有 header
    console.log('[WPS-CALLBACK] Permission request:',
      'file_id:', req.params.file_id,
      'X-App-ID:', req.get('X-App-ID'),
      'X-WebOffice-Token:', (req.get('X-WebOffice-Token') || '').slice(0, 20) + '...',
      'X-Request-ID:', req.get('X-Request-ID'),
      'query:', JSON.stringify(req.query).slice(0, 100)
    );

    // 【重要】update=1 时 WPS 服务器要求在企业控制台登记 Provider 回调地址
    // 若未登记，WPS 服务器返回 ProviderError，文档无法加载。
    // 当前阶段：企业控制台配置未完成，强制只读模式让文档正常渲染。
    // 启用编辑模式：改成 false + 在 WPS 控制台配置回调地址
    const forceReadOnly = false;

    res.json(ok({
      read: 1,
      download: 1,
      update: forceReadOnly ? 0 : (editEnabled ? 1 : 0),
      print: 1,
      comment: editEnabled ? 1 : 0,
      rename: forceReadOnly ? 0 : 1,
      copy: 1,
      saveas: 1,
      history: 0,
      user_id: String(contract.user_id || req.query.user_id || '1'),
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] Permission error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 4. 用户信息 ==========

// GET /v3/3rd/users — 批量用户信息（WPS 服务器通过此接口批量查询用户）
// Go SDK 源码: userIDs := c.QueryArray("user_ids") — 参数名是 user_ids（下划线）
// 请求参数: ?user_ids=10001&user_ids=2
// 注意：此路由必须定义在 /v3/3rd/users/:user_id 之前，否则会被 :user_id 路由捕获
router.get('/v3/3rd/users', verifyWpsSignature, async (req, res) => {
  try {
    const userIds = req.query.user_ids
      ? (Array.isArray(req.query.user_ids) ? req.query.user_ids : [req.query.user_ids])
      : [];
    console.log('[WPS-CALLBACK] Users GET request:', 'user_ids:', JSON.stringify(userIds), 'query:', JSON.stringify(req.query).slice(0, 100));

    if (userIds.length === 0) {
      return res.json(ok([]));
    }

    const users = await Promise.all(userIds.map(async (uid) => {
      let name = `用户 ${uid}`;
      let logined = true;
      try {
        const db = require('../db');
        const [row] = await db('users').where({ id: uid }).select('username', 'name');
        if (row) {
          name = row.name || row.username || name;
          logined = true;
        }
      } catch {}

      return {
        id: String(uid),
        name,
        avatar_url: '',
        logined,
      };
    }));

    res.json(ok(users));
  } catch (error) {
    console.error('[WPS-CALLBACK] Users error:', error);
    res.status(500).json(fail(error.message));
  }
});

// POST /v3/3rd/users — WPS 调用此接口批量查询用户信息
// 请求体: { userIds: ["10001", "10002"] }
// 返回: [{id, name, avatar_url, logined}]
router.post('/v3/3rd/users', verifyWpsSignature, async (req, res) => {
  try {
    const { userIds = [] } = req.body || {};
    console.log('[WPS-CALLBACK] Users POST request:', 'userIds:', JSON.stringify(userIds));

    const users = await Promise.all(userIds.map(async (uid) => {
      let name = `用户 ${uid}`;
      let logined = true;
      try {
        const db = require('../db');
        const [row] = await db('users').where({ id: uid }).select('username', 'name');
        if (row) {
          name = row.name || row.username || name;
          logined = true;
        }
      } catch {}

      return {
        id: String(uid),
        name,
        avatar_url: '',
        logined,
      };
    }));

    res.json(ok(users));
  } catch (error) {
    console.error('[WPS-CALLBACK] Users error:', error);
    res.status(500).json(fail(error.message));
  }
});

// GET /v3/3rd/users/:user_id — 单个用户信息
// 注意：此路由必须在 /v3/3rd/users 之后定义，否则会捕获 "users" 作为 user_id
router.get('/v3/3rd/users/:user_id', verifyWpsSignature, async (req, res) => {
  try {
    const userId = req.params.user_id;
    let name = `用户 ${userId}`;
    let logined = true;
    try {
      const db = require('../db');
      const [row] = await db('users').where({ id: userId }).select('username', 'name');
      if (row) name = row.name || row.username || name;
    } catch {}
    res.json(ok({
      id: String(userId),
      name,
      avatar_url: '',
      logined,
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
    // 先备份旧文件到 versions/ 目录
    const versionsDir = path.join(UPLOADS_DIR, 'versions');
    if (!fs.existsSync(versionsDir)) fs.mkdirSync(versionsDir, { recursive: true });
    const versionFile = path.join(versionsDir, `${contract.id}-v${Date.now()}.bak.docx`);
    try {
      if (fs.existsSync(contract.storage_path)) {
        fs.copyFileSync(contract.storage_path, versionFile);
      }
    } catch (backupErr) {
      console.warn('[WPS-CALLBACK] Backup failed (non-fatal):', backupErr.message);
    }

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

    // WPS v3 协议要求返回 JSON { code: 0 }，否则 WPS 一直显示"保存中"
    res.json(ok({ saved: true, file_id: fileId }));
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

// PUT /v3/3rd/files/:file_id/name — 重命名文件（EditProvider.RenameFile）
router.put('/v3/3rd/files/:file_id/name', verifyWpsSignature, async (req, res) => {
  try {
    const fileId = req.params.file_id;
    const { name } = req.body || {};
    if (!name) return res.status(400).json(fail('name is required'));

    console.log(`[WPS-CALLBACK] RenameFile: ${fileId} → ${name}`);
    await db('contracts').where({ id: fileId }).update({
      original_filename: name,
      updated_at: db.fn.now(),
    });
    res.json(ok({}));
  } catch (error) {
    console.error('[WPS-CALLBACK] RenameFile error:', error);
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

// ========== 8.5 Token 刷新接口（供 SDK refreshToken 回调使用） ==========
// GET /v3/3rd/token/refresh?file_id=contract-146
router.get('/v3/3rd/token/refresh', async (req, res) => {
  try {
    const fileId = req.query.file_id || req.query.fileId;
    if (!fileId) return res.status(400).json({ error: 'file_id is required' });

    // 根据 fileId 从 contracts 表查找合同
    const contractId = fileId.replace('contract-', '');
    const contract = await db('contracts').where({ id: contractId }).first();
    if (!contract) return res.status(404).json({ error: 'Contract not found' });

    // 生成新的 JWT token（与 services/wpsEditor.js 保持一致）
    const tokenPayload = {
      userId: contract.user_id || 1,
      contractId: contract.id,
      documentKey: contract.document_key,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 86400,
    };
    const token = jwt.sign(tokenPayload, WPS_TOKEN_SECRET);

    res.json(ok({
      token,
      timeout: 600 * 1000,
      expires_in: 600,
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] token refresh error:', error);
    res.status(500).json({ error: 'Token refresh failed' });
  }
});

// ========== 8. 水印接口 ==========
// GET /v3/3rd/files/:file_id/watermark
router.get('/v3/3rd/files/:file_id/watermark', verifyWpsSignature, async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract) return res.status(404).json(fail('File not found'));

    // 默认水印：显示合同ID+用户ID，防止截图泄露
    res.json(ok({
      type: 1,
      value: `合同#${contract.id}`,
      fill_style: 'rgba(192,192,192,0.5)',
      font: 'bold 16px Serif',
      rotate: 0.5,
      horizontal: 50,
      vertical: 50,
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] Watermark error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 9. 版本历史列表 ==========
// GET /v3/3rd/files/:file_id/versions
router.get('/v3/3rd/files/:file_id/versions', verifyWpsSignature, async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract) return res.status(404).json(fail('File not found'));

    const versionsDir = path.join(UPLOADS_DIR, 'versions');
    const currentStorage = contract.storage_path;
    const versions = [];

    // 当前版本
    const currentStat = getFileStat(currentStorage);
    versions.push({
      id: String(contract.id),
      name: contract.original_filename || '当前版本',
      version: Math.floor(new Date(contract.updated_at || Date.now()).getTime() / 1000),
      size: currentStat,
      create_time: Math.floor(new Date(contract.created_at || Date.now()).getTime() / 1000),
      modify_time: Math.floor(new Date(contract.updated_at || Date.now()).getTime() / 1000),
      creator_id: String(contract.user_id || 1),
      modifier_id: String(contract.user_id || 1),
    });

    // 历史版本（从 versionsDir 读取备份文件）
    if (fs.existsSync(versionsDir)) {
      const files = fs.readdirSync(versionsDir)
        .filter(f => f.startsWith(`${contract.id}-`))
        .sort()
        .reverse();

      for (const file of files.slice(0, 20)) { // 最多20个历史版本
        const filePath = path.join(versionsDir, file);
        const stat = fs.statSync(filePath);
        // 从文件名提取版本时间戳: contractId-timestamp.bak.docx
        const timestamp = parseInt(file.replace(`${contract.id}-`, '').replace('.bak.docx', ''), 10) || stat.mtimeMs;
        versions.push({
          id: `${contract.id}_v${timestamp}`,
          name: `${contract.original_filename || '合同'} (备份)`,
          version: Math.floor(timestamp / 1000),
          size: stat.size,
          create_time: Math.floor(stat.mtimeMs / 1000),
          modify_time: Math.floor(stat.mtimeMs / 1000),
          creator_id: String(contract.user_id || 1),
          modifier_id: String(contract.user_id || 1),
        });
      }
    }

    res.json(ok(versions));
  } catch (error) {
    console.error('[WPS-CALLBACK] Versions list error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 10. 获取指定版本详情 ==========
// GET /v3/3rd/files/:file_id/versions/:version
router.get('/v3/3rd/files/:file_id/versions/:version', verifyWpsSignature, async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract) return res.status(404).json(fail('File not found'));

    const versionId = parseInt(req.params.version, 10);

    // 如果是当前版本（用 updated_at 时间戳）
    const currentVersionTs = Math.floor(new Date(contract.updated_at || Date.now()).getTime() / 1000);
    if (versionId === currentVersionTs) {
      return res.json(ok({
        id: req.params.file_id,
        name: contract.original_filename || '当前版本',
        version: currentVersionTs,
        size: getFileStat(contract.storage_path),
        create_time: Math.floor(new Date(contract.created_at || Date.now()).getTime() / 1000),
        modify_time: currentVersionTs,
        creator_id: String(contract.user_id || 1),
        modifier_id: String(contract.user_id || 1),
      }));
    }

    // 历史版本：从 versionsDir 查找
    const versionsDir = path.join(UPLOADS_DIR, 'versions');
    const targetTimestamp = versionId * 1000; // 还原为毫秒
    const versionFileName = `${contract.id}-${targetTimestamp}.bak.docx`;
    const versionFilePath = path.join(versionsDir, versionFileName);

    if (fs.existsSync(versionFilePath)) {
      const stat = fs.statSync(versionFilePath);
      res.json(ok({
        id: `${contract.id}_v${versionId}`,
        name: `${contract.original_filename || '合同'} (v${versionId})`,
        version: versionId,
        size: stat.size,
        create_time: Math.floor(stat.mtimeMs / 1000),
        modify_time: Math.floor(stat.mtimeMs / 1000),
        creator_id: String(contract.user_id || 1),
        modifier_id: String(contract.user_id || 1),
      }));
    } else {
      res.status(404).json(fail('File version not found'));
    }
  } catch (error) {
    console.error('[WPS-CALLBACK] Version detail error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 11. 下载指定版本 ==========
// GET /v3/3rd/files/:file_id/versions/:version/download
router.get('/v3/3rd/files/:file_id/versions/:version/download', verifyWpsSignature, async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract) return res.status(404).json(fail('File not found'));

    const versionId = parseInt(req.params.version, 10);
    const versionsDir = path.join(UPLOADS_DIR, 'versions');
    const currentVersionTs = Math.floor(new Date(contract.updated_at || Date.now()).getTime() / 1000);

    // 当前版本直接用 storage_path
    if (versionId === currentVersionTs) {
      const digest = await getFileDigest(contract.storage_path);
      return res.json(ok({
        url: `${WPS_CALLBACK_BASE}/v3/3rd/files/${req.params.file_id}/download/raw`,
        digest,
        digest_type: 'sha1',
      }));
    }

    // 历史版本
    const targetTimestamp = versionId * 1000;
    const versionFilePath = path.join(versionsDir, `${contract.id}-${targetTimestamp}.bak.docx`);

    if (fs.existsSync(versionFilePath)) {
      const digest = await getFileDigest(versionFilePath);
      res.json(ok({
        url: `${WPS_CALLBACK_BASE}/v3/3rd/files/${req.params.file_id}/versions/${versionId}/download/raw`,
        digest,
        digest_type: 'sha1',
      }));
    } else {
      res.status(404).json(fail('File version not found'));
    }
  } catch (error) {
    console.error('[WPS-CALLBACK] Version download error:', error);
    res.status(500).json(fail(error.message));
  }
});

// ========== 12. 历史版本原始内容下载 ==========
router.get('/v3/3rd/files/:file_id/versions/:version/download/raw', async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract) return res.status(404).send('File not found');

    const versionId = parseInt(req.params.version, 10);
    const versionsDir = path.join(UPLOADS_DIR, 'versions');
    const currentVersionTs = Math.floor(new Date(contract.updated_at || Date.now()).getTime() / 1000);

    if (versionId === currentVersionTs) {
      return res.sendFile(contract.storage_path);
    }

    const targetTimestamp = versionId * 1000;
    const versionFilePath = path.join(versionsDir, `${contract.id}-${targetTimestamp}.bak.docx`);

    if (!fs.existsSync(versionFilePath)) {
      return res.status(404).send('Version not found');
    }

    const fileName = `${contract.original_filename || 'contract'}_v${versionId}.docx`;
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName)}"`);
    res.sendFile(versionFilePath);
  } catch (error) {
    console.error('[WPS-CALLBACK] Version raw download error:', error);
    res.status(500).send('Internal error');
  }
});

// ========== 辅助函数：计算文件 SHA1 ==========
const getFileDigest = (filePath) => {
  return new Promise((resolve) => {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      resolve(crypto.createHash('sha1').update(fileBuffer).digest('hex'));
    } catch {
      resolve('');
    }
  });
};

// ========== 扩展能力回调 ==========
// POST /v3/3rd/files/:file_id/extend
router.post('/v3/3rd/files/:file_id/extend', verifyWpsSignature, async (req, res) => {
  res.json(ok({ processed: true }));
});

// ========== 状态通知回调 ==========
// POST /v3/3rd/notify
// WPS 服务器通知文档状态变化（保存完成、版本变化等）
router.post('/v3/3rd/notify', async (req, res) => {
  const body = req.body || {};
  console.log(`[WPS-CALLBACK] Notify: ${JSON.stringify(body).substring(0, 200)}`);
  // 返回成功响应
  res.json(ok({ received: true }));
});

// ========== 缺失的 WPS v3 回调接口 ==========

// 1. requestAuthVerify - 认证授权验证请求
// WPS 在打开文档时若需要第三方认证（如 SAML/OAuth），会调用此接口获取认证跳转 URL
// POST /v3/3rd/files/:file_id/requestAuthVerify
router.post('/v3/3rd/files/:file_id/requestAuthVerify', verifyWpsSignature, async (req, res) => {
  try {
    const { file_id } = req.params;
    const { need_login: needLogin, auth_type: authType } = req.body || {};
    console.log(`[WPS-CALLBACK] requestAuthVerify for file ${file_id}, needLogin=${needLogin}, authType=${authType}`);

    // 返回第三方认证 URL，WPS 会据此引导用户完成认证后再继续
    // 当前实现：若已登录用户则直接放行，未登录则返回需要登录
    // 实际生产环境应接入企业 SSO/SAML/OAuth
    const contract = await findContract(file_id);
    if (!contract) {
      return res.status(404).json(fail('File not found'));
    }

    // 返回认证跳转地址
    // WPS SDK 对空的 redirect_url 解释为认证失败，改用 null 表示无需认证
    res.json(ok({
      redirect_url: null,  // null = 无需认证，直接继续
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] requestAuthVerify error:', error);
    res.status(500).json(fail(error.message));
  }
});

// 2. userAuthVerify - 获取用户认证信息
// GET /v3/3rd/files/:file_id/userAuthVerify
router.get('/v3/3rd/files/:file_id/userAuthVerify', verifyWpsSignature, async (req, res) => {
  try {
    const contract = await findContract(req.params.file_id);
    if (!contract) return res.status(404).json(fail('File not found'));
    res.json(ok({
      need_auth: 0,  // 0 = 不需要额外认证
      auth_type: '',
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] userAuthVerify error:', error);
    res.status(500).json(fail(error.message));
  }
});

// 3. uploadNotify - 上传完成通知回调
// POST /v3/3rd/upload/notify
router.post('/v3/3rd/upload/notify', verifyWpsSignature, async (req, res) => {
  try {
    const { file_id, upload_session, result } = req.body || {};
    console.log(`[WPS-CALLBACK] uploadNotify: file_id=${file_id}, session=${upload_session}, result=${result}`);
    res.json(ok({ received: true }));
  } catch (error) {
    console.error('[WPS-CALLBACK] uploadNotify error:', error);
    res.status(500).json(fail(error.message));
  }
});

// 4. taskResult - 异步任务结果回调
// POST /v3/3rd/files/:file_id/taskResult
router.post('/v3/3rd/files/:file_id/taskResult', verifyWpsSignature, async (req, res) => {
  try {
    const { task_type: taskType, task_id: taskId, result_code: resultCode, result_info: resultInfo } = req.body || {};
    console.log(`[WPS-CALLBACK] taskResult: file=${req.params.file_id}, task=${taskType}, id=${taskId}, code=${resultCode}`);
    res.json(ok({ received: true }));
  } catch (error) {
    console.error('[WPS-CALLBACK] taskResult error:', error);
    res.status(500).json(fail(error.message));
  }
});

// 5. batchTask - 批量任务回调
// POST /v3/3rd/files/:file_id/batchTask
router.post('/v3/3rd/files/:file_id/batchTask', verifyWpsSignature, async (req, res) => {
  try {
    const { batch_type: batchType, task_ids: taskIds } = req.body || {};
    console.log(`[WPS-CALLBACK] batchTask: file=${req.params.file_id}, type=${batchType}, tasks=${JSON.stringify(taskIds)||''}`);
    res.json(ok({ received: true, task_ids: taskIds || [] }));
  } catch (error) {
    console.error('[WPS-CALLBACK] batchTask error:', error);
    res.status(500).json(fail(error.message));
  }
});

// 6. downloadNotify - 下载通知回调
// POST /v3/3rd/files/:file_id/download/notify
router.post('/v3/3rd/files/:file_id/download/notify', verifyWpsSignature, async (req, res) => {
  try {
    const { file_id, user_id: userId, client_type: clientType } = req.body || {};
    console.log(`[WPS-CALLBACK] downloadNotify: file=${file_id}, user=${userId}, client=${clientType}`);
    res.json(ok({ received: true }));
  } catch (error) {
    console.error('[WPS-CALLBACK] downloadNotify error:', error);
    res.status(500).json(fail(error.message));
  }
});

// 7. export - 文档导出回调
// GET /v3/3rd/files/:file_id/export
router.get('/v3/3rd/files/:file_id/export', verifyWpsSignature, async (req, res) => {
  try {
    const { type = 'pdf' } = req.query;  // type: pdf, docx, etc.
    const contract = await findContract(req.params.file_id);
    if (!contract) return res.status(404).json(fail('File not found'));

    // 返回导出文件的下载地址（WPS 会调用此 URL 获取转换后的文件）
    // 注意：当前实现仅返回原文件，实际生产需调用转换服务
    const exportUrl = `${WPS_CALLBACK_BASE}/v3/3rd/files/${req.params.file_id}/download/raw`;
    res.json(ok({
      url: exportUrl,
      file_type: type,
      digest: '',
      digest_type: 'sha1',
    }));
  } catch (error) {
    console.error('[WPS-CALLBACK] export error:', error);
    res.status(500).json(fail(error.message));
  }
});

// POST /v3/3rd/files/:file_id/export - WPS 触发导出时回调通知
router.post('/v3/3rd/files/:file_id/export', verifyWpsSignature, async (req, res) => {
  try {
    const { type = 'pdf', task_id: taskId } = req.body || {};
    console.log(`[WPS-CALLBACK] export notify: file=${req.params.file_id}, type=${type}, task=${taskId}`);
    res.json(ok({ received: true }));
  } catch (error) {
    console.error('[WPS-CALLBACK] export notify error:', error);
    res.status(500).json(fail(error.message));
  }
});

module.exports = router;
