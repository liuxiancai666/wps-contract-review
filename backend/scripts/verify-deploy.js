/**
 * 部署后全链路自检脚本
 * 验证：后端可达性、Embedding、Milvus、PG知识库覆盖
 * 用法: node scripts/verify-deploy.js
 */
require('dotenv').config();
const http = require('http');

const BACKEND_URL = 'http://127.0.0.1:8689';

async function main() {
  let failures = 0;
  const results = [];

  const check = (name, ok, detail) => {
    if (ok) {
      results.push(`  ✅ ${name}: ${detail || 'ok'}`);
    } else {
      results.push(`  ❌ ${name}: ${detail || 'FAILED'}`);
      failures++;
    }
  };

  // 1. 后端 HTTP 可达
  try {
    const body = await httpGet(`${BACKEND_URL}/`);
    check('HTTP 200', body.includes('ContractGE Backend'));
  } catch (e) {
    check('HTTP 200', false, e.message);
  }

  // 2. 健康检查 API
  try {
    const body = await httpGet(`${BACKEND_URL}/api/health`);
    const data = JSON.parse(body);
    check('Health API', data.status === 'ok' || data.status === 'degraded',
      `status=${data.status}`);
    for (const [svc, status] of Object.entries(data.services)) {
      if (typeof status === 'string' && !status.startsWith('error')) {
        check(`  service.${svc}`, true, status);
      } else if (typeof status === 'number') {
        results.push(`  ℹ️  ${svc}: ${status}`);
      }
    }
    if (data.services.knowledge_warning) {
      check('知识覆盖', false, data.services.knowledge_warning);
    }
  } catch (e) {
    check('Health API', false, e.message);
  }

  // 3. Embedding 直测
  try {
    const { embedText } = require('../services/embeddingClient');
    const emb = await embedText('验证合同审查系统部署');
    check('Embedding', emb?.length > 0, `dim=${emb.length}`);
  } catch (e) {
    check('Embedding', false, e.message.slice(0, 80));
  }

  // 4. Milvus 直测
  try {
    const { MilvusClient } = require('@zilliz/milvus2-sdk-node');
    const c = new MilvusClient({ address: process.env.MILVUS_ADDRESS || '127.0.0.1:19530' });
    const collection = process.env.MILVUS_COLLECTION || 'contract_review_knowledge';
    const ok = await c.hasCollection({ collection_name: collection });
    check('Milvus 集合', ok?.value === true);
    if (ok?.value === true) {
      const cnt = await c.count({ collection_name: collection });
      check('Milvus 向量数', cnt?.data > 0, `${cnt?.data || 0} vectors`);
    }
  } catch (e) {
    check('Milvus 连接', false, e.message.slice(0, 60));
  }

  // 5. PG 知识库覆盖率
  try {
    const db = require('../database');
    const titles = await db('vector_documents').select('title').distinct();
    const count = await db('vector_documents').count('* as cnt');
    check('PG 知识库', count[0]?.cnt > 0, `${count[0]?.cnt} chunks, ${titles.length} titles`);

    const fs = require('fs');
    const path = require('path');
    const lawsDir = path.join(__dirname, '..', 'data', 'laws');
    let expectedFiles = 0;
    for (const dir of fs.readdirSync(lawsDir)) {
      const dirPath = path.join(lawsDir, dir);
      if (fs.statSync(dirPath).isDirectory()) {
        expectedFiles += fs.readdirSync(dirPath).filter(f => f.endsWith('.md') && !f.startsWith('_')).length;
      }
    }
    const ratio = titles.length / expectedFiles;
    if (expectedFiles > 0) {
      check('法律覆盖率', ratio >= 0.9, `${titles.length}/${expectedFiles} (${(ratio*100).toFixed(0)}%)`);
    }
  } catch (e) {
    check('PG 知识库', false, e.message.slice(0, 80));
  }

  // 输出结果
  console.log(`\n🔍 合同审查系统自检报告 — ${new Date().toISOString()}`);
  console.log('='.repeat(54));
  results.forEach(r => console.log(r));
  console.log('='.repeat(54));
  console.log(`\n${failures > 0 ? `❌ ${failures} 项检查失败` : '✅ 全链路检查通过'}`);
  process.exit(failures > 0 ? 1 : 0);
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

main();
