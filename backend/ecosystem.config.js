module.exports = {
  apps: [{
    name: 'contract-review-backend',
    script: 'index.js',
    cwd: '/root/data/disk/apps/wps-contract-review/backend',
    instances: 1,
    exec_mode: 'fork',
    autorestart: true,
    // 崩溃后等待3秒再重启，防止端口 EADDRINUSE 冲突
    restart_delay: 3000,
    // 最多保留5个旧日志文件
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'production',
      PORT: 8089,
    },
    // 崩溃退出码白名单（0=正常退出，1=一般错误，都重启）
    // 非零退出码才重启
    exp_backoff_restart_delay: 100,
  }]
};
