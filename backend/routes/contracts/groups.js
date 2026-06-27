const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const unidecode = require('unidecode');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const iconv = require('iconv-lite');
const AdmZip = require('adm-zip');
const PDFDocument = require('pdfkit');
const { createWorker } = require('tesseract.js');
const db = require('../database');
const { searchVectorDocumentsMulti, splitIntoParagraphGroups } = require('../services/vectorStore');
const { getTemplateById, matchTemplate } = require('../services/reviewTemplates');
const { extractCompanyNames, searchCompanyInfo } = require('../services/webSearch');
const { createChatCompletion } = require('../services/llmClient');

// 合同正文段落 chunk 检索上限：0 = 不限；超过部分不再生成子 query，控制长合同的检索成本
const CONTRACT_CHUNK_MAX = Math.max(0, Number(process.env.CONTRACT_CHUNK_MAX || 0));

const router = express.Router();

const ONLYOFFICE_JWT_SECRET = process.env.ONLYOFFICE_JWT_SECRET;
const ONLYOFFICE_URL = process.env.ONLYOFFICE_URL || 'http://localhost:8081';
const APP_HOST = process.env.APP_HOST;
const BACKEND_URL_FOR_DOCKER = process.env.BACKEND_URL_FOR_DOCKER || APP_HOST;

const ALLOWED_EXTENSIONS = ['.docx', '.pdf'];
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', 'uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1E9)}`;
        const sanitizedOriginalName = unidecode(file.originalname).replace(/[^a-zA-Z0-9.\-_]/g, '_');
        cb(null, `${uniqueSuffix}-${sanitizedOriginalName}`);
    },
});
const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
            return cb(new Error(`UNSUPPORTED_FILE_TYPE:${ext}`));
        }
        cb(null, true);
    },
});

// ===== ROUTES =====
router.post('/groups', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const name = String(req.body?.name || `关联合同组 ${new Date().toISOString()}`).trim();
    const [group] = await db('contract_groups').insert({ user_id: userId, name, status: 'Uploaded' }).returning(['id', 'name', 'created_at', 'status']);
    res.status(201).json(group);
});

router.get('/groups/:groupId', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const group = await db('contract_groups')
            .where({ id: req.params.groupId, user_id: userId })
            .first();
        if (!group) return res.status(404).json({ error: '未找到该关联合同分析记录。' });

        const contracts = await db('contracts')
            .where({ user_id: userId, group_id: req.params.groupId })
            .select('id', 'original_filename', 'created_at', 'status')
            .orderBy('created_at', 'asc');

        res.json({
            id: group.id,
            name: group.name,
            status: group.status,
            created_at: group.created_at,
            updated_at: group.updated_at,
            result: parseJsonField(group.analysis_result, {}),
            contracts,
        });
    } catch (error) {
        console.error(`[ERROR] Failed to fetch contract group ${req.params.groupId}:`, error);
        res.status(500).json({ error: '获取关联合同分析记录失败。' });
    }
});

// 关联分析结果导出（issue 10.3）
router.get('/groups/:groupId/export', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const group = await db('contract_groups')
            .where({ id: req.params.groupId, user_id: userId })
            .first();
        if (!group) return res.status(404).json({ error: '未找到该关联合同分析记录。' });

        const contracts = await db('contracts')
            .where({ user_id: userId, group_id: req.params.groupId })
            .select('id', 'original_filename')
            .orderBy('created_at', 'asc');
        const result = parseJsonField(group.analysis_result, {});
        const format = String(req.query.format || 'html').toLowerCase();
        const basename = (group.name || 'group-analysis').replace(/[^a-zA-Z0-9._-]/g, '_');

        const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(group.name)} 关联分析报告</title>
<style>
body { font-family: Arial, sans-serif; line-height: 1.6; padding: 32px; color: #1f2937; }
h1, h2 { color: #111827; }
.item { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin: 10px 0; }
</style></head><body>
<h1>多合同关联分析报告</h1>
<p><strong>分析组名称：</strong> ${escapeHtml(group.name)}</p>
<p><strong>导出时间：</strong> ${new Date().toLocaleString('zh-CN')}</p>
<p><strong>涉及合同：</strong> ${contracts.map((c) => escapeHtml(c.original_filename)).join('、')}</p>
${result.summary ? `<h2>整体结论</h2><p>${escapeHtml(result.summary)}</p>` : ''}
<h2>条款冲突与矛盾</h2>
${(result.conflicts || []).map((item, i) => `<div class="item"><h3>${escapeHtml(item.title || `冲突点 ${i + 1}`)}</h3><p>${escapeHtml(item.description || '')}</p>${item.contract_refs?.length ? `<p><strong>涉及文件：</strong>${escapeHtml(item.contract_refs.join('、'))}</p>` : ''}${item.suggestion ? `<p><strong>处理建议：</strong>${escapeHtml(item.suggestion)}</p>` : ''}</div>`).join('') || '<p>暂无数据。</p>'}
<h2>跨合同共同风险</h2>
${(result.shared_risks || []).length ? `<ul>${result.shared_risks.map((r) => `<li>${escapeHtml(r)}</li>`).join('')}</ul>` : '<p>暂无数据。</p>'}
</body></html>`;

        if (format === 'pdf') {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${basename}-group-analysis.pdf"`);
            const doc = new PDFDocument({ margin: 48, size: 'A4' });
            const fontPath = findPdfFont();
            if (fontPath) { try { doc.font(fontPath); } catch (e) { console.warn('[PDF] Font load failed:', e.message); } }
            doc.pipe(res);
            doc.fontSize(18).text('多合同关联分析报告');
            doc.moveDown(0.5).fontSize(10).text(`分析组：${group.name}`).text(`导出时间：${new Date().toLocaleString('zh-CN')}`).text(`涉及合同：${contracts.map((c) => c.original_filename).join('、')}`);
            if (result.summary) { doc.moveDown().fontSize(14).text('整体结论').fontSize(11).text(result.summary); }
            doc.moveDown().fontSize(14).text('条款冲突与矛盾');
            (result.conflicts || []).forEach((item, i) => {
                doc.moveDown(0.5).fontSize(11).text(`${i + 1}. ${item.title || ''}\n${item.description || ''}${item.suggestion ? `\n建议：${item.suggestion}` : ''}`);
            });
            if (!result.conflicts?.length) doc.fontSize(10).text('暂无数据。');
            doc.moveDown().fontSize(14).text('跨合同共同风险');
            (result.shared_risks || []).forEach((r) => doc.fontSize(11).text(`• ${r}`));
            if (!result.shared_risks?.length) doc.fontSize(10).text('暂无数据。');
            return doc.end();
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${basename}-group-analysis.html"`);
        res.send(html);
    } catch (error) {
        console.error(`[ERROR] Failed to export group ${req.params.groupId}:`, error);
        res.status(500).json({ error: '导出关联分析报告失败。' });
    }
});

router.delete('/groups/:groupId', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const contracts = await db('contracts')
            .where({ user_id: userId, group_id: req.params.groupId })
            .select('id', 'storage_path');
        await Promise.all(contracts.map((contract) => (
            contract.storage_path ? fs.promises.unlink(contract.storage_path).catch(() => {}) : Promise.resolve()
        )));
        await db('contracts').where({ user_id: userId, group_id: req.params.groupId }).del();
        const deleted = await db('contract_groups').where({ id: req.params.groupId, user_id: userId }).del();
        if (!deleted) return res.status(404).json({ error: '未找到该关联合同分析记录。' });
        res.json({ message: '关联合同分析记录已删除。' });
    } catch (error) {
        console.error(`[ERROR] Failed to delete contract group ${req.params.groupId}:`, error);
        res.status(500).json({ error: '删除关联合同分析记录失败。' });
    }
});

router.post('/groups/:groupId/analyze', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const group = await db('contract_groups').where({ id: req.params.groupId, user_id: userId }).first();
    if (!group) return res.status(404).json({ error: '未找到该关联合同组。' });

    const contracts = await db('contracts')
        .where({ user_id: userId, group_id: req.params.groupId })
        .select('id', 'original_filename', 'storage_path');
    if (contracts.length < 2) {
        return res.status(400).json({ error: '多合同关联分析至少需要 2 份合同。' });
    }

    try {
        const documents = await Promise.all(contracts.map(async (contract) => ({
            id: contract.id,
            filename: contract.original_filename,
            text: await extractTextFromFile(contract.storage_path),
        })));
        const prompt = `你是一名资深合同审查律师。请对同一组关联合同进行整体审查，识别主合同、附件协议、补充协议之间的冲突、重复、遗漏和前后矛盾。只输出 JSON，不输出自然语言解释。
输出结构：{"conflicts":[{"title":"冲突标题","contract_refs":["涉及的合同文件名或编号"],"description":"冲突或矛盾说明","suggestion":"处理建议"}],"shared_risks":["跨合同共同风险"],"summary":"整体结论"}
关联合同内容：
${documents.map((doc, index) => `[DOCUMENT_${index + 1}: ${doc.filename}]\n${wrapContractContent(doc.text)}`).join('\n\n')}`;
        const result = await callJsonLLM(prompt);
        await db('contract_groups').where({ id: req.params.groupId, user_id: userId }).update({
            analysis_result: JSON.stringify(result),
            status: 'Reviewed',
            updated_at: db.fn.now(),
        });
        res.json({ contracts: contracts.map(({ id, original_filename }) => ({ id, original_filename })), result });
    } catch (error) {
        console.error('[ERROR] Linked contract analysis failed:', error);
        res.status(500).json({ error: '多合同关联分析失败，请稍后重试。' });
    }
});

module.exports = router;
module.exports.setIoInstance = setIoInstance;
