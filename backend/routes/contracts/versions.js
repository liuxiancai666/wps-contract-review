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
router.post('/:id/replace-text', async (req, res) => {
    const userId = req.header('X-User-ID');
    const { originalText, suggestedText, originalCandidates = [] } = req.body || {};
    if (!originalText || !suggestedText) {
        return res.status(400).json({ error: 'originalText and suggestedText are required.' });
    }

    try {
        const query = db('contracts').where({ id: req.params.id });
        if (userId) query.andWhere({ user_id: userId });
        const contract = await query.first();
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
        if (ext !== 'docx') {
            return res.status(400).json({
                error: 'PDF 文件暂不支持原文直接改写，请使用 PDF 批注意见或审查报告导出。',
                code: 'PDF_REPLACE_NOT_SUPPORTED',
            });
        }

        const version = await createContractVersionSnapshot(contract, 'replace-text');
        const replacements = replaceTextInDocx(contract.storage_path, originalText, suggestedText, originalCandidates);
        const nextKey = uuidv4();
        await db('contracts').where({ id: contract.id }).update({
            document_key: nextKey,
            updated_at: db.fn.now(),
        });
        const updatedContract = { ...contract, document_key: nextKey };
        res.json({
            replacements,
            version,
            editorConfig: buildOnlyOfficeConfig(updatedContract, ext),
        });
    } catch (error) {
        if (error.message === 'DOCX_EXACT_TEXT_NOT_FOUND') {
            return res.status(409).json({
                error: '未能在 DOCX 源文件中精确匹配原文，请先定位原文或缩短替换片段后重试。',
            });
        }
        console.error('[ERROR] Server-side DOCX replacement failed:', error);
        res.status(500).json({ error: '服务端 DOCX 替换失败。' });
    }
});
router.post('/:id/batch-replace-text', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const suggestions = Array.isArray(req.body?.suggestions) ? req.body.suggestions : [];
    if (!suggestions.length) return res.status(400).json({ error: '请至少选择一条修改建议。' });

    try {
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
        if (ext !== 'docx') {
            return res.status(400).json({
                error: 'PDF 文件暂不支持原文直接改写，请下载 PDF 批注意见。',
                code: 'PDF_REPLACE_NOT_SUPPORTED',
            });
        }

        const version = await createContractVersionSnapshot(contract, 'batch-replace-text');
        const results = [];
        let totalReplacements = 0;
        let succeededCount = 0;
        let failedCount = 0;

        for (const [index, item] of suggestions.entries()) {
            const originalText = item.originalText || item.original_text || item.original_clause;
            const suggestedText = item.suggestedText || item.suggested_text || item.modification;
            if (!originalText || !suggestedText) {
                failedCount += 1;
                results.push({ index, ok: false, error: '缺少原文或建议修改文本。', title: item.title || '' });
                continue;
            }
            try {
                const replacements = replaceTextInDocx(
                    contract.storage_path,
                    originalText,
                    suggestedText,
                    item.originalCandidates || item.original_candidates || [],
                );
                totalReplacements += replacements;
                succeededCount += 1;
                results.push({ index, ok: true, replacements, title: item.title || '' });
            } catch (error) {
                failedCount += 1;
                results.push({ index, ok: false, error: error.message, title: item.title || '' });
            }
        }

        const nextKey = uuidv4();
        await db('contracts').where({ id: contract.id }).update({
            document_key: nextKey,
            updated_at: db.fn.now(),
        });

        res.json({
            version,
            totalReplacements,
            succeededCount,
            failedCount,
            results,
            editorConfig: buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, ext),
        });
    } catch (error) {
        console.error('[ERROR] Batch DOCX replacement failed:', error);
        res.status(500).json({ error: '批量替换失败。' });
    }
});
router.post('/:id/append-clause', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const { title, content } = req.body || {};
    if (!content || !String(content).trim()) {
        return res.status(400).json({ error: '追加条款内容不能为空。' });
    }

    try {
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const ext = path.extname(contract.storage_path).toLowerCase().replace('.', '');
        if (ext !== 'docx') {
            return res.status(400).json({
                error: 'PDF 文件暂不支持追加条款，请手动添加或导出审查报告。',
                code: 'PDF_APPEND_NOT_SUPPORTED',
            });
        }

        // 创建版本快照
        const version = await createContractVersionSnapshot(contract, 'append-clause');

        // 使用 adm-zip 修改 DOCX，在 document.xml 末尾追加段落
        const zip = new AdmZip(contract.storage_path);
        const documentXmlEntry = zip.getEntry('word/document.xml');
        if (!documentXmlEntry) {
            return res.status(500).json({ error: 'DOCX 文件结构异常，无法找到 document.xml。' });
        }
        let documentXml = documentXmlEntry.getData().toString('utf8');
        const escapeXml = (text) => String(text || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

        // 构建追加的段落 XML
        const titlePara = title
            ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(title)}</w:t></w:r></w:p>`
            : '';
        const contentParas = String(content).split(/\n+/).map((line) =>
            `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`
        ).join('');
        const insertXml = `${titlePara}${contentParas}`;

        // 在 </w:body> 前插入新段落
        documentXml = documentXml.replace('</w:body>', `${insertXml}</w:body>`);
        zip.updateFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
        zip.writeZip(contract.storage_path);

        const nextKey = uuidv4();
        await db('contracts').where({ id: contract.id }).update({
            document_key: nextKey,
            updated_at: db.fn.now(),
        });

        res.json({
            ok: true,
            version,
            message: `已追加条款「${title || '未命名条款'}」到文档末尾。`,
            editorConfig: buildOnlyOfficeConfig({ ...contract, document_key: nextKey }, ext),
        });
    } catch (error) {
        console.error('[ERROR] Append clause failed:', error);
        res.status(500).json({ error: '追加条款失败。' });
    }
});

router.get('/:id/versions', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const contract = await findOwnedContract(req.params.id, userId);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    const versions = await db('contract_versions')
        .where({ contract_id: contract.id })
        .select('id', 'version_no', 'source_action', 'created_at')
        .orderBy('version_no', 'desc');
    res.json({ versions });
});
router.get('/:id/diff', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const contract = await findOwnedContract(req.params.id, userId);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    const { fromVersionId, toVersionId, versionId } = req.query;

    // 模式1: 对比两个指定版本
    if (fromVersionId && toVersionId) {
        const fromVersion = await db('contract_versions')
            .where({ id: fromVersionId, contract_id: contract.id }).first();
        const toVersion = await db('contract_versions')
            .where({ id: toVersionId, contract_id: contract.id }).first();
        if (!fromVersion || !toVersion) {
            return res.status(404).json({ error: '未找到指定的版本快照。' });
        }
        return res.json({
            fromVersion: { id: fromVersion.id, version_no: fromVersion.version_no, source_action: fromVersion.source_action, created_at: fromVersion.created_at },
            toVersion: { id: toVersion.id, version_no: toVersion.version_no, source_action: toVersion.source_action, created_at: toVersion.created_at },
            diff: diffText(fromVersion.plain_text || '', toVersion.plain_text || ''),
        });
    }

    // 模式2: 对比当前版本 vs 指定历史版本（原有逻辑）
    const versionQuery = db('contract_versions').where({ contract_id: contract.id });
    if (versionId) versionQuery.andWhere({ id: versionId });
    const version = await versionQuery.orderBy('version_no', 'desc').first();
    if (!version) return res.status(404).json({ error: '暂无可对比的版本快照。' });

    const currentText = await extractTextFromFile(contract.storage_path);
    res.json({
        version: {
            id: version.id,
            version_no: version.version_no,
            source_action: version.source_action,
            created_at: version.created_at,
        },
        diff: diffText(version.plain_text || '', currentText),
    });
});


module.exports = router;
module.exports.setIoInstance = setIoInstance;
