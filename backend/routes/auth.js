const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../database');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES = '7d';

// 启动时强制校验 JWT_SECRET
if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('环境变量 JWT_SECRET 必须设置且长度不少于 32 个字符。请检查 .env 文件。');
}

// 角色枚举
const ROLES = { ADMIN: 'admin', USER: 'user' };

// ─── JWT 中间件 ───────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供登录凭证' });
  }
  try {
    const token = header.split(' ')[1];
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: '登录凭证无效或已过期' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.user.role !== ROLES.ADMIN) {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
}

// ─── POST /api/auth/register ──────────────────────────────────
router.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少6位' });
  }

  try {
    const existing = await db('users').where({ username }).first();
    if (existing) {
      return res.status(409).json({ error: '用户名已存在' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const [id] = await db('users')
      .insert({ username, password_hash, role: ROLES.USER, fingerprint_id: `registered-${Date.now()}` })
      .returning('id');

    const token = jwt.sign({ id, username, role: ROLES.USER }, JWT_SECRET, { expiresIn: JWT_EXPIRES });

    res.status(201).json({ id, username, role: ROLES.USER, token });
  } catch (err) {
    console.error('[Auth] Register error:', err);
    res.status(500).json({ error: '注册失败' });
  }
});

// ─── POST /api/auth/login ─────────────────────────────────────
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  try {
    const user = await db('users').where({ username }).first();
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username, role: user.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES }
    );

    res.json({
      id: user.id,
      username: user.username,
      role: user.role,
      token,
      fingerprint_id: user.fingerprint_id,
    });
  } catch (err) {
    console.error('[Auth] Login error:', err);
    res.status(500).json({ error: '登录失败' });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await db('users')
      .select('id', 'username', 'role', 'fingerprint_id', 'created_at')
      .where({ id: req.user.id })
      .first();

    if (!user) return res.status(404).json({ error: '用户不存在' });

    res.json(user);
  } catch (err) {
    console.error('[Auth] Me error:', err);
    res.status(500).json({ error: '获取用户信息失败' });
  }
});

// ─── POST /api/auth/link-fingerprint ───────────────────────────
// 将当前匿名 fingerprint 用户绑定到已登录账号
router.post('/link-fingerprint', authMiddleware, async (req, res) => {
  const { fingerprint_id } = req.body;
  if (!fingerprint_id) {
    return res.status(400).json({ error: 'fingerprint_id 不能为空' });
  }

  try {
    // 检查 fingerprint 是否已被其他账号绑定
    const existing = await db('users')
      .where({ fingerprint_id })
      .whereNot({ id: req.user.id })
      .first();
    if (existing) {
      return res.status(409).json({ error: '该设备已绑定其他账号' });
    }

    // 更新 fingerprint_id
    await db('users').where({ id: req.user.id }).update({ fingerprint_id });

    // 同时更新该 fingerprint 下的合同归属到当前用户
    await db('contracts').where({ user_id: null }).orWhere({ user_id: req.user.id }).update({ user_id: req.user.id });

    res.json({ message: '绑定成功' });
  } catch (err) {
    console.error('[Auth] Link fingerprint error:', err);
    res.status(500).json({ error: '绑定失败' });
  }
});

// ═══════════════════════════════════════════════════════════════
// 以下路由需要 admin 权限
// ═══════════════════════════════════════════════════════════════

// ─── POST /api/auth/users (admin — 创建用户) ────────────────────
router.post('/users', authMiddleware, adminMiddleware, async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少6位' });
  }

  try {
    const existing = await db('users').where({ username }).first();
    if (existing) {
      return res.status(409).json({ error: '用户名已存在' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const finalRole = role && Object.values(ROLES).includes(role) ? role : ROLES.USER;
    const [id] = await db('users')
      .insert({ username, password_hash, role: finalRole, fingerprint_id: `admin-created-${Date.now()}` })
      .returning('id');

    res.status(201).json({
      id: typeof id === 'object' ? id.id : id,
      username,
      role: finalRole,
    });
  } catch (err) {
    console.error('[Auth] Admin create user error:', err);
    res.status(500).json({ error: '创建用户失败' });
  }
});

// ─── GET /api/auth/users (admin) ───────────────────────────────
router.get('/users', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const users = await db('users')
      .select('id', 'username', 'role', 'fingerprint_id', 'created_at', 'updated_at')
      .orderBy('created_at', 'desc');
    res.json(users);
  } catch (err) {
    console.error('[Auth] List users error:', err);
    res.status(500).json({ error: '获取用户列表失败' });
  }
});

// ─── PUT /api/auth/users/:id (admin) ───────────────────────────
router.put('/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;
  const { username, password, role } = req.body;

  try {
    const updateData = {};
    if (username !== undefined) updateData.username = username;
    if (password) updateData.password_hash = await bcrypt.hash(password, 10);
    if (role !== undefined) {
      if (!Object.values(ROLES).includes(role)) {
        return res.status(400).json({ error: '无效的角色' });
      }
      updateData.role = role;
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: '没有要更新的字段' });
    }

    await db('users').where({ id }).update(updateData);
    res.json({ message: '更新成功' });
  } catch (err) {
    console.error('[Auth] Update user error:', err);
    res.status(500).json({ error: '更新用户失败' });
  }
});

// ─── DELETE /api/auth/users/:id (admin) ────────────────────────
router.delete('/users/:id', authMiddleware, adminMiddleware, async (req, res) => {
  const { id } = req.params;

  // 禁止删除自己的账号
  if (Number(id) === req.user.id) {
    return res.status(400).json({ error: '不能删除自己的账号' });
  }

  try {
    await db('users').where({ id }).del();
    res.json({ message: '删除成功' });
  } catch (err) {
    console.error('[Auth] Delete user error:', err);
    res.status(500).json({ error: '删除用户失败' });
  }
});

module.exports = router;
module.exports.authMiddleware = authMiddleware;
module.exports.adminMiddleware = adminMiddleware;
module.exports.ROLES = ROLES;
