# WPS 合同审查系统

## 部署信息

| 项目 | 内容 |
|------|------|
| **端口** | 由环境变量 `PORT` / `APP_HOST` 决定 |
| **后端端口** | 由环境变量 `PORT` 决定（默认 3000） |
| **数据库** | PostgreSQL（通过 Docker Compose 启动） |
| **前端目录** | 由部署环境决定 |
| **后端目录** | 由部署环境决定 |
| **PM2 进程** | 参考 `ecosystem.config.js` 配置 |

## Nginx

前端通过 Nginx 反向代理到后端 API。

## 外网访问

由环境变量 `APP_HOST` / `CORS_ORIGIN` 配置。

## 环境变量

请参考 `.env.example` 文件配置所有必要的环境变量：

- `JWT_SECRET` — 必须设置且长度 >= 32 字符
- `WPS_TOKEN_SECRET` — 必须设置且长度 >= 32 字符
- `DATABASE_URL` — PostgreSQL 连接字符串
- `WPS_APP_ID` / `WPS_APP_SECRET` — WPS 开放平台凭证

## 启动步骤

1. 复制环境变量：`cp .env.example .env`（Linux/Mac）或 `copy .env.example .env`（Windows）
2. 编辑 `.env` 填入所有必要配置
3. 启动基础设施：`docker compose up -d`
4. 启动后端：`cd backend && npm start`
5. 启动前端：`cd frontend && npm run dev`
