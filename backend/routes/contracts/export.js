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
router.get('/:id/export-report', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const contract = await findOwnedContract(req.params.id, userId);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    const format = String(req.query.format || 'html').toLowerCase();
    const reviewData = parseJsonField(contract.analysis_result, parseJsonField(contract.analysis_partial_result, {}));
    const basename = path.basename(contract.original_filename, path.extname(contract.original_filename)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'contract';

    if (format === 'pdf') {
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${basename}-review-report.pdf"`);
        return streamReviewReportPdf(res, contract, reviewData);
    }

    if (format === 'word' || format === 'docx') {
        // 真正的 DOCX 格式（OOXML），非 HTML 伪装
        const docxBuffer = generateDocxBuffer(contract, reviewData);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.setHeader('Content-Disposition', `attachment; filename="${basename}-review-report.docx"`);
        return res.send(docxBuffer);
    }

    const html = renderReviewReportHtml(contract, reviewData, format);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${basename}-review-report.html"`);
    res.send(html);
});
router.get('/:id/pdf-annotations', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const contract = await findOwnedContract(req.params.id, userId);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    const reviewData = parseJsonField(contract.analysis_result, parseJsonField(contract.analysis_partial_result, {}));
    const suggestions = reviewData.modification_suggestions || [];
    const lines = [
        `PDF 合同批注意见：${contract.original_filename}`,
        `导出时间：${new Date().toISOString()}`,
        '',
        ...suggestions.flatMap((item, index) => [
            `#${index + 1} ${item.title || item.clause || '修改建议'}`,
            `原文：${item.original_text || item.original_clause || ''}`,
            `建议修改为：${item.suggested_text || item.modification || ''}`,
            `修改理由：${item.reason || item.rationale || ''}`,
            '',
        ]),
    ];
    const basename = path.basename(contract.original_filename, path.extname(contract.original_filename)).replace(/[^a-zA-Z0-9._-]/g, '_') || 'contract';
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${basename}-pdf-annotations.txt"`);
    res.send(lines.join('\n'));
});

module.exports = router;
module.exports.setIoInstance = setIoInstance;
