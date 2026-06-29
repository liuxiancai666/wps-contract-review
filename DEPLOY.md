# WPS 合同审查系统

## 部署信息

| 项目 | 内容 |
|------|------|
| **端口** | 8085 |
| **后端端口** | 8089 |
| **数据库** | `wps_contract_review`（PostgreSQL Docker）|
| **前端目录** | `/var/www/wps-contract-review` |
| **后端目录** | `/root/data/disk/apps/wps-contract-review` |
| **PM2 进程** | `wps-contract-review-backend` |
| **ONLYOFFICE** | 共享 8086 实例 |

## Nginx

端口 8085，配置: `/etc/nginx/sites-enabled/wps-contract-review`

## 外网访问

`http://82.157.138.176:8085`

## 克隆来源

从原合同审查系统（contract-review，8082端口）完整克隆：
- 复制 `/root/data/disk/apps/contract-review-v2` → `wps-contract-review`
- 后端端口 8689 → 8089
- 数据库 `contract_review` → `wps_contract_review`
- 前端端口 8082 → 8085
