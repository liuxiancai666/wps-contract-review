require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const contractRoutes = require('./routes/contracts');
const qaRoutes = require('./routes/qa');
const userRoutes = require('./routes/users');
const knowledgeRoutes = require('./routes/knowledge');
const templateRoutes = require('./routes/templates');
const rulesRoutes = require('./routes/rules');
const wpsCallbackRoutes = require('./routes/wps-callback');
const wpsAuthRoutes = require('./routes/wps-auth');
const authRoutes = require('./routes/auth');
const db = require('./database');
const resetAndRebuildDatabase = require('./database-check');

const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});
const port = process.env.PORT || 3000;

// Middleware
const allowedOrigins = (process.env.CORS_ORIGIN || process.env.APP_HOST || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
    origin: function(origin, callback) {
        // 允许没有 origin 的请求（如测试工具、服务器内部调用）
        if (!origin) return callback(null, true);
        // 允许明确配置的域名，或在开发环境允许所有 localhost
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (process.env.NODE_ENV !== 'production') {
            if (origin && (origin.includes('localhost') || origin.includes('127.0.0.1'))) {
                return callback(null, true);
            }
        }
        console.warn('[CORS] Blocked origin:', origin, '| allowed:', allowedOrigins);
        callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Trust proxy for correct rate-limiting behind nginx
app.set('trust proxy', 1);

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: { error: '请求过于频繁，请稍后再试。' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);

const analyzeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: { error: 'AI 分析请求过于频繁，每分钟最多 5 次。' },
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api/contracts/analyze', analyzeLimiter);

// Socket.io logic
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join-contract', (contractId) => {
    socket.join(`contract-${contractId}`);
    console.log(`User ${socket.id} joined room: contract-${contractId}`);
    // Notify others in the room
    socket.to(`contract-${contractId}`).emit('user-joined', { userId: socket.id });
  });

  socket.on('analysis-started', (data) => {
    // data should contain contractId and perhaps user info
    socket.to(`contract-${data.contractId}`).emit('analysis-progress', { status: 'started', user: data.user });
  });

  socket.on('analysis-finished', (data) => {
    // Broadcast analysis results to everyone in the room
    io.to(`contract-${data.contractId}`).emit('analysis-complete', data.results);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// Serve static files from the 'public' directory
const publicDir = path.join(__dirname, 'public');
if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
}
app.use(express.static(publicDir));

// Serve static files from the "uploads" directory
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));

// Attach io to app for use in routes
app.set('io', io);
// 注入 io 实例到 contracts 路由，供后台异步分析任务推送进度
contractRoutes.setIoInstance(io);

// API Routes
app.use('/api/contracts', contractRoutes);
app.use('/api/qa', qaRoutes);
app.use('/api/users', userRoutes);
app.use('/api/knowledge', authRoutes.authMiddleware, authRoutes.adminMiddleware, knowledgeRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/rules', rulesRoutes);

// Auth 路由（登录/注册/用户管理）
app.use('/api/auth', authRoutes);

// WPS WebOffice SDK auth 代理（必须在静态文件之前）
app.use('/office/v5/ai', wpsAuthRoutes);

// DEBUG: 临时测试端点 - 在 wpsAuthRoutes 之后验证路由
app.post('/office/v5/ai/test', (req, res) => {
    console.log('[DEBUG] /office/v5/ai/test endpoint HIT - wpsAuthRoutes works!');
    res.json({ ok: true, msg: 'wpsAuthRoutes is working' });
});

// WPS WebOffice v3 回调路由（必须是公网可达）
app.use(wpsCallbackRoutes);

app.get('/', (req, res) => {
  res.send('ContractGE Backend is running!');
});

// Multer 错误处理中间件：文件大小超限、格式不支持等返回 JSON
app.use((err, req, res, next) => {
  if (err) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: '文件大小超过 50MB 限制，请压缩或拆分后上传。', code: 'FILE_TOO_LARGE' });
    }
    if (err.message && err.message.startsWith('UNSUPPORTED_FILE_TYPE')) {
      return res.status(400).json({ error: '仅支持 .docx、.doc 和 .pdf 格式的文件。', code: 'UNSUPPORTED_FILE_TYPE' });
    }
    console.error('[ERROR] Unhandled middleware error:', err);
    return res.status(500).json({ error: '服务器处理请求时发生错误。' });
  }
  next();
});

// ========== 进程级异常处理（防止未捕获异常导致静默崩溃） ==========
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.stack || err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection at:', promise, 'reason:', reason);
});

async function startServer() {
  await resetAndRebuildDatabase();
  server.listen(port, () => {
    console.log(`Backend server listening at http://localhost:${port}`);
  });
}

startServer();
