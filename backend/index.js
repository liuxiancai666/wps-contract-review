require('dotenv').config({ override: true });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const contractRoutes = require('./routes/contracts');
const qaRoutes = require('./routes/qa');
const userRoutes = require('./routes/users');
const knowledgeRoutes = require('./routes/knowledge');
const templateRoutes = require('./routes/templates');
const resetAndRebuildDatabase = require('./database-check');

const app = express();
const server = http.createServer(app);

// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// CORS - restricted to known origins
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
  : ['http://82.157.138.176:8082', 'http://localhost:8082'];

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
  },
});

const port = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: allowedOrigins }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Socket.io logic
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  socket.on('join-contract', (contractId) => {
    socket.join(`contract-${contractId}`);
    console.log(`User ${socket.id} joined room: contract-${contractId}`);
    socket.to(`contract-${contractId}`).emit('user-joined', { userId: socket.id });
  });

  socket.on('analysis-started', (data) => {
    socket.to(`contract-${data.contractId}`).emit('analysis-progress', { status: 'started', user: data.user });
  });

  socket.on('analysis-finished', (data) => {
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
contractRoutes.setIoInstance(io);

// API Routes
app.use('/api/contracts', contractRoutes);
app.use('/api/qa', qaRoutes);
app.use('/api/users', userRoutes);
app.use('/api/knowledge', knowledgeRoutes);
app.use('/api/templates', templateRoutes);

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
      return res.status(400).json({ error: '仅支持 .docx 和 .pdf 格式的文件。', code: 'UNSUPPORTED_FILE_TYPE' });
    }
    console.error('[ERROR] Unhandled middleware error:', err);
    return res.status(500).json({ error: '服务器处理请求时发生错误。' });
  }
  next();
});

async function startServer() {
  await resetAndRebuildDatabase();
  server.listen(port, () => {
    console.log(`Backend server listening at http://localhost:${port}`);
  });
}

startServer();
