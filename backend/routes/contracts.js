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
const { searchVectorDocuments } = require('../services/vectorStore');
const { getTemplateById, matchTemplate } = require('../services/reviewTemplates');
const { extractCompanyNames, searchCompanyInfo } = require('../services/webSearch');
const { createChatCompletion } = require('../services/llmClient');

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

// 检测 PDF 是否为扫描件（图像型）：文本极少且页数大于0
const detectScannedPdf = (pdfData) => {
    const text = String(pdfData.text || '').replace(/\s+/g, '');
    const pageCount = pdfData.numpages || (pdfData.info && pdfData.info.Pages) || 1;
    // 每页平均有效字符少于 50 视为扫描件
    const avgCharsPerPage = text.length / Math.max(pageCount, 1);
    return {
        isScanned: pageCount > 0 && avgCharsPerPage < 50,
        textLength: text.length,
        pageCount,
        avgCharsPerPage: Math.round(avgCharsPerPage),
    };
};

const extractTextFromFile = async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.docx') {
        const { value } = await mammoth.extractRawText({ path: filePath });
        if (!value || !value.trim()) {
            const err = new Error('DOCX 文本提取为空，文件可能已损坏或为空文档。');
            err.code = 'EMPTY_TEXT';
            throw err;
        }
        return value;
    }
    if (ext === '.pdf') {
        const data = await pdf(fs.readFileSync(filePath));
        const scanInfo = detectScannedPdf(data);
        if (scanInfo.isScanned || !data.text || !data.text.trim()) {
            const err = new Error('该 PDF 疑似扫描件（图像型），无法提取文本内容。请上传可复制的文字版 PDF，或先用 OCR 工具转换为文字版后再上传。');
            err.code = 'SCANNED_PDF';
            err.scanInfo = scanInfo;
            throw err;
        }
        return data.text;
    }
    const err = new Error(`Unsupported file extension: ${ext}`);
    err.code = 'UNSUPPORTED_FILE_TYPE';
    throw err;
};

const CONTRACT_CONTENT_BEGIN = '[BEGIN_CONTRACT_CONTENT]';
const CONTRACT_CONTENT_END = '[END_CONTRACT_CONTENT]';

const wrapContractContent = (text) => [
    CONTRACT_CONTENT_BEGIN,
    String(text || ''),
    CONTRACT_CONTENT_END,
].join('\n');

const getRequestUserId = (req) => {
    const raw = req.header('X-User-ID') || req.body?.userId || req.query?.userId;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
};

const requireRequestUserId = (req, res) => {
    const userId = getRequestUserId(req);
    if (!userId) {
        res.status(401).json({ error: 'User ID is required for access.' });
        return null;
    }
    return userId;
};

const findOwnedContract = (id, userId) => db('contracts').where({ id, user_id: userId }).first();

// ===== 异步分析任务管理 =====
// 内存级任务存储，用于追踪分析进度并支持断线恢复
const analysisJobs = new Map();
let ioInstance = null;
const setIoInstance = (io) => { ioInstance = io; };

// 分析步骤定义：每步的权重（百分比）和预估耗时（秒）
const ANALYSIS_STEPS = [
    { key: 'extract_text', label: '提取合同正文', weight: 5, estSeconds: 3 },
    { key: 'knowledge_search', label: '检索法条与案例依据', weight: 20, estSeconds: 15 },
    { key: 'company_search', label: '核验合同主体信息', weight: 15, estSeconds: 12 },
    { key: 'llm_review', label: 'AI 生成审查结论', weight: 50, estSeconds: 60 },
    { key: 'seal_analysis', label: '印章与签章核验', weight: 7, estSeconds: 8 },
    { key: 'finalize', label: '保存审查结果', weight: 3, estSeconds: 2 },
];
const TOTAL_EST_SECONDS = ANALYSIS_STEPS.reduce((sum, s) => sum + s.estSeconds, 0);

const getStepProgress = (stepKey, status) => {
    const idx = ANALYSIS_STEPS.findIndex((s) => s.key === stepKey);
    if (idx < 0) return { percent: 0, stepIndex: 0, totalSteps: ANALYSIS_STEPS.length };
    let cumulative = 0;
    for (let i = 0; i < idx; i += 1) cumulative += ANALYSIS_STEPS[i].weight;
    const step = ANALYSIS_STEPS[idx];
    const percent = status === 'completed' ? cumulative + step.weight : cumulative + Math.round(step.weight * 0.5);
    return { percent: Math.min(percent, 100), stepIndex: idx, totalSteps: ANALYSIS_STEPS.length };
};

const createAnalysisJob = (contractId, userId) => {
    const job = {
        jobId: uuidv4(),
        contractId: Number(contractId),
        userId,
        status: 'queued',
        currentStep: null,
        percent: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        steps: ANALYSIS_STEPS.map((s) => ({ ...s, status: 'pending', message: '' })),
        error: null,
        result: null,
    };
    analysisJobs.set(Number(contractId), job);
    return job;
};

const updateAnalysisJob = (contractId, updates) => {
    const job = analysisJobs.get(Number(contractId));
    if (!job) return null;
    Object.assign(job, updates, { updatedAt: Date.now() });
    return job;
};

const emitAnalysisProgress = async (reqOrIo, contractId, payload) => {
    const stepKey = payload.step;
    const status = payload.status;
    const { percent, stepIndex, totalSteps } = getStepProgress(stepKey, status);

    const event = {
        contractId: Number(contractId),
        timestamp: new Date().toISOString(),
        percent,
        stepIndex,
        totalSteps,
        stepLabel: ANALYSIS_STEPS.find((s) => s.key === stepKey)?.label || stepKey,
        elapsedSeconds: 0,
        estimatedRemainingSeconds: Math.max(0, TOTAL_EST_SECONDS - Math.round((TOTAL_EST_SECONDS * percent) / 100)),
        ...payload,
    };

    // 更新内存任务状态
    const job = analysisJobs.get(Number(contractId));
    if (job) {
        job.percent = percent;
        job.currentStep = stepKey;
        job.status = status === 'failed' ? 'failed' : (percent >= 100 ? 'completed' : 'running');
        job.elapsedSeconds = Math.round((Date.now() - job.startedAt) / 1000);
        event.elapsedSeconds = job.elapsedSeconds;
        const stepEntry = job.steps.find((s) => s.key === stepKey);
        if (stepEntry) {
            stepEntry.status = status;
            stepEntry.message = payload.message || '';
        }
    }

    // 通过 Socket.IO 推送（支持 req 或直接使用 ioInstance）
    const io = reqOrIo?.app?.get?.('io') || ioInstance;
    if (io) io.to(`contract-${contractId}`).emit('analysis-progress', event);

    const partial = payload.partialResult ? JSON.stringify(payload.partialResult) : undefined;
    const update = {
        analysis_status: payload.status || payload.step || 'processing',
        updated_at: db.fn.now(),
    };
    if (partial) update.analysis_partial_result = partial;
    await db('contracts').where({ id: contractId }).update(update).catch(() => null);
};

const cleanJsonResponse = (text) => {
    const clean = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
};

const callJsonLLM = async (prompt) => {
    const completion = await createChatCompletion({
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
    });
    return cleanJsonResponse(completion.choices[0].message.content);
};

const buildWpsConfig = (contractRecord, userId) => {
    const rawExt = path.extname(contractRecord.storage_path || '').toLowerCase().replace('.', '') || 'docx';
    // WPS SDK officeType 单字母映射
    const OFFICE_TYPE_MAP = {
        'doc': 'w', 'docx': 'w', 'wpt': 'w', 'dot': 'w', 'rtf': 'w',
        'xls': 's', 'xlsx': 's', 'xlt': 's', 'csv': 's', 'et': 's',
        'ppt': 'p', 'pptx': 'p', 'pps': 'p', 'dps': 'p',
        'pdf': 'f',
        'otl': 'o',
        'dbt': 'd',
        'ksheet': 'k', 'kex': 'k',
    };
    const fileSuffix = OFFICE_TYPE_MAP[rawExt] || 'w';  // 默认 Writer
    const fileId = `contract-${contractRecord.id}`;
    const hasReviewResult = !!(contractRecord.analysis_result && contractRecord.analysis_status === 'completed');
    const mode = hasReviewResult ? 'nomal' : 'simple';
    const WPS_APP_ID = process.env.WPS_APP_ID || 'SX20260701SKURKN';
    const WPS_TOKEN_SECRET = process.env.WPS_TOKEN_SECRET;
    const WPS_ENDPOINT = process.env.WPS_ENDPOINT || 'https://o.wpsgo.com';

    // 生成 JWT token（供 WPS SDK 初始化用）
    let token = null;
    if (WPS_TOKEN_SECRET) {
        try {
            token = jwt.sign(
                {
                    appId: WPS_APP_ID,
                    userId: String(userId),
                    contractId: String(contractRecord.id),
                    fileId,
                    exp: Math.floor(Date.now() / 1000) + 7200, // 2小时有效期
                },
                WPS_TOKEN_SECRET,
                { algorithm: 'HS256' }
            );
        } catch (err) {
            console.error('[buildWpsConfig] JWT sign error:', err.message);
        }
    }

    return {
        appId: WPS_APP_ID,
        fileId,
        fileSuffix: fileSuffix,  // WPS SDK 单字母代码（w/s/p/f/o/d/k）
        mode,          // 'nomal'=有审查结果/'simple'=编辑模式
        endpoint: WPS_ENDPOINT,
        token,         // JWT token（SDK 初始化用）
        hasReviewResult,
    };
};

const buildOnlyOfficeConfig = (contractRecord, ext = 'docx') => {
    const isPdf = ext === 'pdf';
    const fileUrl = `${BACKEND_URL_FOR_DOCKER}/api/uploads/${path.basename(contractRecord.storage_path)}`;
    const callbackUrl = `${BACKEND_URL_FOR_DOCKER}/api/contracts/save-callback`;
    const payload = {
        document: {
            fileType: ext,
            key: contractRecord.document_key,
            title: contractRecord.original_filename,
            url: fileUrl,
            permissions: {
                comment: !isPdf,
                download: true,
                edit: !isPdf,
                print: true,
                review: !isPdf,
            },
        },
        documentType: isPdf ? 'pdf' : 'word',
        editorConfig: {
            callbackUrl,
            lang: 'zh-CN',
            mode: isPdf ? 'view' : 'edit',
            user: {
                id: `user-${contractRecord.user_id || 1}`,
                name: 'Reviewer',
            },
            customization: {
                forcesave: !isPdf,
                comments: true,
                compactHeader: true,
                compactToolbar: true,
                toolbarHideFileName: true,
                toolbarNoTabs: true,
                features: {
                    tabStyle: 'line',
                    tabBackground: 'toolbar',
                    spellcheck: false,
                },
                hideRightMenu: true,
                hideRulers: true,
                help: false,
                plugins: false,
                chat: false,
                feedback: false,
                goback: false,
            },
        },
    };
    return ONLYOFFICE_JWT_SECRET
        ? { ...payload, token: jwt.sign(payload, ONLYOFFICE_JWT_SECRET) }
        : payload;
};

const postOnlyOfficeCommand = async (payload) => {
    const commandPayload = ONLYOFFICE_JWT_SECRET
        ? { ...payload, token: jwt.sign(payload, ONLYOFFICE_JWT_SECRET) }
        : payload;

    const headers = { 'Content-Type': 'application/json' };
    if (ONLYOFFICE_JWT_SECRET) {
        headers.Authorization = `Bearer ${commandPayload.token}`;
    }

    const response = await axios.post(
        `${ONLYOFFICE_URL.replace(/\/$/, '')}/coauthoring/CommandService.ashx`,
        commandPayload,
        { headers, timeout: 10000 },
    );
    return response.data;
};

const escapeXmlText = (text) => String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const unescapeXmlText = (text) => String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const normalizeForDocxMatch = (text) => {
    const normalized = [];
    const indexMap = [];
    for (let index = 0; index < String(text || '').length; index += 1) {
        const char = String(text)[index]
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/[：]/g, ':')
            .replace(/[，]/g, ',')
            .replace(/[。]/g, '.');
        if (/\s/.test(char)) continue;
        normalized.push(char);
        indexMap.push(index);
    }
    return { value: normalized.join(''), indexMap };
};

const findDocxTextRange = (fullText, candidate) => {
    const exactIndex = fullText.indexOf(candidate);
    if (exactIndex >= 0) {
        return { start: exactIndex, end: exactIndex + candidate.length };
    }

    const normalizedFull = normalizeForDocxMatch(fullText);
    const normalizedCandidate = normalizeForDocxMatch(candidate).value;
    if (!normalizedCandidate) return null;

    const normalizedIndex = normalizedFull.value.indexOf(normalizedCandidate);
    if (normalizedIndex < 0) return null;

    const start = normalizedFull.indexMap[normalizedIndex];
    const end = normalizedFull.indexMap[normalizedIndex + normalizedCandidate.length - 1] + 1;
    return { start, end };
};

const replaceTextInXmlRuns = (xml, candidate, suggestedText) => {
    const textRunPattern = /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g;
    const runs = [];
    let match;
    let fullText = '';

    while ((match = textRunPattern.exec(xml)) !== null) {
        const decodedText = unescapeXmlText(match[2]);
        runs.push({
            matchStart: match.index,
            matchEnd: match.index + match[0].length,
            attrs: match[1],
            rawText: match[2],
            text: decodedText,
            start: fullText.length,
            end: fullText.length + decodedText.length,
        });
        fullText += decodedText;
    }

    const range = findDocxTextRange(fullText, candidate);
    if (!range) return { xml, replaced: false };

    let inserted = false;
    const safeSuggestion = String(suggestedText || '').replace(/\r?\n+/g, ' ');
    const parts = [];
    let cursor = 0;

    for (const run of runs) {
        parts.push(xml.slice(cursor, run.matchStart));
        cursor = run.matchEnd;

        if (run.end <= range.start || run.start >= range.end) {
            parts.push(`<w:t${run.attrs}>${run.rawText}</w:t>`);
            continue;
        }

        const overlapStart = Math.max(range.start, run.start) - run.start;
        const overlapEnd = Math.min(range.end, run.end) - run.start;
        const before = run.text.slice(0, overlapStart);
        const after = run.text.slice(overlapEnd);
        let nextText = '';

        if (!inserted) {
            nextText = before + safeSuggestion;
            inserted = true;
        }
        if (run.end >= range.end) {
            nextText += after;
        }

        const attrs = /^\s/.test(nextText) || /\s$/.test(nextText)
            ? (run.attrs.includes('xml:space=') ? run.attrs : `${run.attrs} xml:space="preserve"`)
            : run.attrs;
        parts.push(`<w:t${attrs}>${escapeXmlText(nextText)}</w:t>`);
    }

    parts.push(xml.slice(cursor));
    return { xml: parts.join(''), replaced: true };
};

const normalizeReplacementCandidates = (originalText, originalCandidates = []) => {
    const candidates = [originalText, ...originalCandidates]
        .map((item) => String(item || '').trim())
        .filter(Boolean);
    const seen = new Set();
    return candidates.filter((candidate) => {
        const key = normalizeForDocxMatch(candidate).value;
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
};

const replaceTextInDocx = (filePath, originalText, suggestedText, originalCandidates = []) => {
    const zip = new AdmZip(filePath);
    const xmlEntries = zip.getEntries().filter((entry) => /^word\/.*\.xml$/.test(entry.entryName));
    const escapedSuggestion = escapeXmlText(suggestedText);
    const candidates = normalizeReplacementCandidates(originalText, originalCandidates);
    let replacements = 0;

    for (const entry of xmlEntries) {
        let xml = entry.getData().toString('utf8');
        let updated = false;

        for (const candidate of candidates) {
            const escapedOriginal = escapeXmlText(candidate);
            const exactCount = xml.split(escapedOriginal).length - 1;
            if (exactCount > 0) {
                xml = xml.split(escapedOriginal).join(escapedSuggestion);
                replacements += exactCount;
                updated = true;
                break;
            }

            const runReplacement = replaceTextInXmlRuns(xml, candidate, suggestedText);
            if (runReplacement.replaced) {
                xml = runReplacement.xml;
                replacements += 1;
                updated = true;
                break;
            }
        }

        if (updated) {
            zip.updateFile(entry.entryName, Buffer.from(xml, 'utf8'));
        }
    }

    if (replacements === 0) {
        throw new Error('DOCX_EXACT_TEXT_NOT_FOUND');
    }

    zip.writeZip(filePath);
    return replacements;
};

const createContractVersionSnapshot = async (contract, sourceAction = 'replace-text') => {
    const result = await db('contract_versions')
        .where({ contract_id: contract.id })
        .max('version_no as next_version_no');
    const nextVersionNo = result[0] ? (result[0].next_version_no || result[0].max || 0) : 0;
    const versionNo = Number(nextVersionNo) + 1;
    const ext = path.extname(contract.storage_path).toLowerCase();
    const snapshotDir = path.join(__dirname, '..', 'uploads', 'versions');
    await fs.promises.mkdir(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `${contract.id}-v${versionNo}-${uuidv4()}${ext}`);
    await fs.promises.copyFile(contract.storage_path, snapshotPath);

    let plainText;
    try {
        plainText = await extractTextFromFile(contract.storage_path);
    } catch (_) {
        plainText = '';
    }

    const [version] = await db('contract_versions').insert({
        contract_id: contract.id,
        user_id: contract.user_id,
        version_no: versionNo,
        source_action: sourceAction,
        storage_path: snapshotPath,
        plain_text: plainText,
    }).returning(['id', 'version_no', 'created_at', 'source_action']);

    return version || { version_no: versionNo, source_action: sourceAction };
};

const diffText = (before, after) => {
    const beforeParts = String(before || '').split(/(\s+)/);
    const afterParts = String(after || '').split(/(\s+)/);
    const rows = Array.from({ length: beforeParts.length + 1 }, () => Array(afterParts.length + 1).fill(0));

    for (let i = beforeParts.length - 1; i >= 0; i -= 1) {
        for (let j = afterParts.length - 1; j >= 0; j -= 1) {
            rows[i][j] = beforeParts[i] === afterParts[j]
                ? rows[i + 1][j + 1] + 1
                : Math.max(rows[i + 1][j], rows[i][j + 1]);
        }
    }

    const changes = [];
    let i = 0;
    let j = 0;
    while (i < beforeParts.length && j < afterParts.length) {
        if (beforeParts[i] === afterParts[j]) {
            changes.push({ type: 'equal', text: beforeParts[i] });
            i += 1;
            j += 1;
        } else if (rows[i + 1][j] >= rows[i][j + 1]) {
            changes.push({ type: 'delete', text: beforeParts[i] });
            i += 1;
        } else {
            changes.push({ type: 'insert', text: afterParts[j] });
            j += 1;
        }
    }
    while (i < beforeParts.length) changes.push({ type: 'delete', text: beforeParts[i++] });
    while (j < afterParts.length) changes.push({ type: 'insert', text: afterParts[j++] });
    return changes.filter((item) => item.text);
};

const escapeHtml = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const parseJsonField = (value, fallback = {}) => {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
};

const renderReviewReportHtml = (contract, reviewData = {}, _format = 'html') => {
    const rows = (items = [], render) => items.map(render).join('\n') || '<p>暂无数据。</p>';
    const severityCount = (points = []) => {
        const counts = { 高: 0, 中: 0, 低: 0 };
        points.forEach((p) => {
            const sev = String(p.severity || '').trim();
            if (counts[sev] !== undefined) counts[sev] += 1;
            else counts['中'] += 1;
        });
        return counts;
    };
    const sev = severityCount(reviewData.dispute_points);
    return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(contract.original_filename)} 审查报告</title>
  <style>
    body { font-family: Arial, sans-serif; line-height: 1.6; padding: 32px; color: #1f2937; }
    h1, h2 { color: #111827; }
    section { margin: 24px 0; }
    .item { border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; margin: 10px 0; }
    .before { color: #991b1b; background: #fef2f2; padding: 8px; }
    .after { color: #166534; background: #f0fdf4; padding: 8px; }
    .dashboard { display: flex; gap: 16px; margin: 16px 0; }
    .dashboard .card { flex: 1; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; text-align: center; }
    .dashboard .card .num { font-size: 28px; font-weight: bold; }
    .dashboard .card.high .num { color: #dc2626; }
    .dashboard .card.mid .num { color: #d97706; }
    .dashboard .card.low .num { color: #16a34a; }
    .severity-tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
    .severity-high { background: #fee2e2; color: #991b1b; }
    .severity-mid { background: #fef3c7; color: #92400e; }
    .severity-low { background: #d1fae5; color: #065f46; }
    .disclaimer { background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 12px; margin: 16px 0; font-size: 13px; color: #92400e; }
    @media print { body { padding: 16px; } }
  </style>
</head>
<body>
  <h1>合同审查报告</h1>
  <p><strong>文件名称：</strong> ${escapeHtml(contract.original_filename)}</p>
  <p><strong>导出时间：</strong> ${new Date().toLocaleString('zh-CN')}</p>
  ${reviewData.template?.name ? `<p><strong>审查模板：</strong> ${escapeHtml(reviewData.template.name)}</p>` : ''}
  ${contract.perspective ? `<p><strong>审查立场：</strong> ${escapeHtml(contract.perspective)}</p>` : ''}

  <div class="dashboard">
    <div class="card high"><div class="num">${sev.高}</div><div>高风险</div></div>
    <div class="card mid"><div class="num">${sev.中}</div><div>中风险</div></div>
    <div class="card low"><div class="num">${sev.低}</div><div>低风险</div></div>
    <div class="card"><div class="num">${(reviewData.dispute_points || []).length}</div><div>风险总数</div></div>
    <div class="card"><div class="num">${(reviewData.missing_clauses || []).length}</div><div>缺失条款</div></div>
  </div>

  <section>
    <h2>一、风险争议点</h2>
    ${rows(reviewData.dispute_points, (item) => {
      const s = String(item.severity || '中').trim();
      const cls = s === '高' ? 'severity-high' : (s === '低' ? 'severity-low' : 'severity-mid');
      return `<div class="item"><h3>${escapeHtml(item.title || item.type || '风险项')} <span class="severity-tag ${cls}">${escapeHtml(s)}</span></h3><p>${escapeHtml(item.dispute_rationale || item.description || '')}</p>${item.legal_reference ? `<p><strong>法律依据：</strong>${escapeHtml(item.legal_reference)}</p>` : ''}${item.plain_language ? `<p><strong>大白话：</strong>${escapeHtml(item.plain_language)}</p>` : ''}</div>`;
    })}
  </section>

  <section>
    <h2>二、缺失条款</h2>
    ${rows(reviewData.missing_clauses, (item) => `<div class="item"><h3>${escapeHtml(item.title || item.clause_type || '缺失条款')}</h3><p>${escapeHtml(item.description || item.reason || '')}</p>${item.suggested_clause ? `<p class="after"><strong>建议补充：</strong>${escapeHtml(item.suggested_clause)}</p>` : ''}</div>`)}
  </section>

  <section>
    <h2>三、主体审查</h2>
    ${rows(reviewData.party_review, (item) => `<div class="item"><h3>${escapeHtml(item.title || item.review_point || '主体审查项')}</h3><p>${escapeHtml(item.description || '')}</p>${item.plain_language ? `<p><strong>大白话：</strong>${escapeHtml(item.plain_language)}</p>` : ''}</div>`)}
    ${rows(reviewData.company_review, (item) => `<div class="item"><h3>${escapeHtml(item.company_name || '公司主体')}</h3><p><strong>状态：</strong>${escapeHtml(item.status || '')}</p><p>${escapeHtml(item.evidence_summary || '')}</p><p><strong>真实性：</strong>${escapeHtml(item.authenticity || '')}</p></div>`)}
  </section>

  <section>
    <h2>四、违约成本分析</h2>
    <div class="disclaimer">⚠️ 以下违约成本由 AI 根据合同条款和法律依据估算，仅供参考，不构成法律意见。实际违约成本以法院判决或仲裁裁决为准。</div>
    ${rows(reviewData.breach_cost_analysis, (item) => `<div class="item"><h3>${escapeHtml(item.scenario || '违约场景')}</h3><p><strong>法律依据：</strong>${escapeHtml(item.legal_basis || '')}</p><p><strong>预计成本：</strong>${escapeHtml(item.estimated_cost || '')}</p></div>`)}
  </section>

  <section>
    <h2>五、印章与签章核验</h2>
    ${rows(reviewData.seal_analysis, (item) => `<div class="item"><h3>${escapeHtml(item.seal_name || '签章检查')}</h3><p><strong>状态：</strong>${escapeHtml(item.status || '')}</p><p><strong>风险等级：</strong>${escapeHtml(item.risk_level || '')}</p><p>${escapeHtml(item.details || '')}</p></div>`)}
  </section>

  <section>
    <h2>六、法条与案例依据</h2>
    ${rows(reviewData.relevant_laws, (item) => `<div class="item"><strong>${escapeHtml(item.law || item.title || '')}</strong><p>${escapeHtml(item.clause || '')}</p><p>${escapeHtml(item.content || '')}</p>${item.source_url ? `<p><a href="${escapeHtml(item.source_url)}">来源链接</a></p>` : ''}</div>`)}
  </section>

  <section>
    <h2>七、修改建议</h2>
    ${rows(reviewData.modification_suggestions, (item) => `<div class="item"><h3>${escapeHtml(item.title || item.clause || '修改建议')}</h3><p class="before">原文：${escapeHtml(item.original_text || item.original_clause || '')}</p><p class="after">建议修改为：${escapeHtml(item.suggested_text || item.modification || '')}</p><p>修改理由：${escapeHtml(item.reason || item.rationale || '')}</p></div>`)}
  </section>
</body>
</html>`;
};

// 生成真正的 DOCX 文件（OOXML 格式，非 HTML 伪装）
const generateDocxBuffer = (contract, reviewData = {}) => {
    const escapeXml = (text) => String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const paragraphs = [];
    const addHeading = (text, level = 1) => {
        const style = level === 1 ? 'Title' : 'Heading1';
        paragraphs.push(`<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`);
    };
    const addParagraph = (text, bold = false) => {
        const rPr = bold ? '<w:rPr><w:b/></w:rPr>' : '';
        paragraphs.push(`<w:p><w:r>${rPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`);
    };
    const addKeyValue = (key, value) => {
        paragraphs.push(`<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${escapeXml(key)}：</w:t></w:r><w:r><w:t xml:space="preserve">${escapeXml(value || '')}</w:t></w:r></w:p>`);
    };

    addHeading('合同审查报告', 1);
    addKeyValue('文件名称', contract.original_filename);
    addKeyValue('导出时间', new Date().toLocaleString('zh-CN'));
    if (reviewData.template?.name) addKeyValue('审查模板', reviewData.template.name);
    if (contract.perspective) addKeyValue('审查立场', contract.perspective);

    const sections = [
        { title: '一、风险争议点', items: reviewData.dispute_points, render: (item) => [
            `${item.title || item.type || '风险项'}（严重程度：${item.severity || '中'}）`,
            item.dispute_rationale || item.description || '',
            item.legal_reference ? `法律依据：${item.legal_reference}` : '',
        ].filter(Boolean) },
        { title: '二、缺失条款', items: reviewData.missing_clauses, render: (item) => [
            item.title || item.clause_type || '缺失条款',
            item.description || item.reason || '',
            item.suggested_clause ? `建议补充：${item.suggested_clause}` : '',
        ].filter(Boolean) },
        { title: '三、主体审查', items: [...(reviewData.party_review || []), ...(reviewData.company_review || [])], render: (item) => [
            item.title || item.review_point || item.company_name || '主体审查项',
            item.description || item.status || '',
            item.evidence_summary || '',
        ].filter(Boolean) },
        { title: '四、违约成本分析（仅供参考）', items: reviewData.breach_cost_analysis, render: (item) => [
            item.scenario || '违约场景',
            item.legal_basis ? `法律依据：${item.legal_basis}` : '',
            item.estimated_cost ? `预计成本：${item.estimated_cost}` : '',
        ].filter(Boolean) },
        { title: '五、印章与签章核验', items: reviewData.seal_analysis, render: (item) => [
            item.seal_name || '签章检查',
            item.status ? `状态：${item.status}` : '',
            item.risk_level ? `风险等级：${item.risk_level}` : '',
            item.details || '',
        ].filter(Boolean) },
        { title: '六、法条与案例依据', items: reviewData.relevant_laws, render: (item) => [
            `${item.law || item.title || ''} ${item.clause || ''}`,
            item.content || '',
        ].filter(Boolean) },
        { title: '七、修改建议', items: reviewData.modification_suggestions, render: (item) => [
            item.title || item.clause || '修改建议',
            `原文：${item.original_text || item.original_clause || ''}`,
            `建议修改为：${item.suggested_text || item.modification || ''}`,
            `修改理由：${item.reason || item.rationale || ''}`,
        ].filter(Boolean) },
    ];

    for (const section of sections) {
        addHeading(section.title, 2);
        const items = section.items || [];
        if (!items.length) {
            addParagraph('暂无数据。');
            continue;
        }
        items.forEach((item, index) => {
            const lines = section.render(item);
            lines.forEach((line, lineIdx) => {
                addParagraph(`${lineIdx === 0 ? `${index + 1}. ` : ''}${line}`, lineIdx === 0);
            });
        });
    }

    const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>
${paragraphs.join('\n')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body>
</w:document>`;

    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

    const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

    const documentRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="SimSun"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Title"><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
</w:styles>`;

    const zip = new AdmZip();
    zip.addFile('[Content_Types].xml', Buffer.from(contentTypesXml, 'utf8'));
    zip.addFile('_rels/.rels', Buffer.from(relsXml, 'utf8'));
    zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
    zip.addFile('word/_rels/document.xml.rels', Buffer.from(documentRelsXml, 'utf8'));
    zip.addFile('word/styles.xml', Buffer.from(stylesXml, 'utf8'));
    return zip.toBuffer();
};

const findPdfFont = () => {
    const candidates = [
        'C:\\Windows\\Fonts\\simhei.ttf',
        'C:\\Windows\\Fonts\\msyh.ttf',
        'C:\\Windows\\Fonts\\msyhbd.ttf',
        'C:\\Windows\\Fonts\\simsun.ttc',
        'C:\\Windows\\Fonts\\Deng.ttf',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
        '/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc',
        '/usr/local/share/fonts/NotoSansCJK-Regular.ttc',
    ];
    const found = candidates.find((fontPath) => fs.existsSync(fontPath));
    if (!found) {
        console.warn('[PDF] No CJK font found. PDF export may show garbled text. Searched:', candidates.join(', '));
    }
    return found;
};

const addPdfSection = (doc, title, items = [], render) => {
    doc.moveDown().fontSize(15).text(title);
    if (!items.length) {
        doc.fontSize(10).text('暂无数据。');
        return;
    }
    items.forEach((item, index) => {
        doc.moveDown(0.5).fontSize(11).text(`${index + 1}. ${render(item)}`);
    });
};

const streamReviewReportPdf = (res, contract, reviewData = {}) => {
    const doc = new PDFDocument({ margin: 48, size: 'A4' });
    const fontPath = findPdfFont();
    if (fontPath) {
        try {
            doc.font(fontPath);
        } catch (error) {
            console.warn(`[PDF] Failed to load font ${fontPath}: ${error.message}`);
        }
    }

    doc.pipe(res);
    doc.fontSize(18).text('合同审查报告');
    doc.moveDown(0.5).fontSize(10).text(`文件名称：${contract.original_filename}`);
    doc.text(`导出时间：${new Date().toLocaleString('zh-CN')}`);
    if (contract.perspective) doc.text(`审查立场：${contract.perspective}`);

    // 风险摘要
    const points = reviewData.dispute_points || [];
    const highCount = points.filter((p) => String(p.severity).trim() === '高').length;
    const midCount = points.filter((p) => String(p.severity).trim() === '中').length;
    const lowCount = points.filter((p) => String(p.severity).trim() === '低').length;
    doc.moveDown().fontSize(12).text(`风险摘要：高危 ${highCount} 项，中危 ${midCount} 项，低危 ${lowCount} 项，缺失条款 ${(reviewData.missing_clauses || []).length} 项。`);

    addPdfSection(doc, '一、风险争议点', points, (item) => [
        `${item.title || item.type || '风险项'}（${item.severity || '中'}）`,
        item.dispute_rationale || item.description || '',
        item.legal_reference || '',
    ].filter(Boolean).join('\n'));
    addPdfSection(doc, '二、缺失条款', reviewData.missing_clauses || [], (item) => [
        item.title || item.clause_type || '缺失条款',
        item.description || item.reason || '',
        item.suggested_clause ? `建议补充：${item.suggested_clause}` : '',
    ].filter(Boolean).join('\n'));
    addPdfSection(doc, '三、主体审查', [...(reviewData.party_review || []), ...(reviewData.company_review || [])], (item) => [
        item.title || item.review_point || item.company_name || '主体审查项',
        item.description || item.status || '',
        item.evidence_summary || '',
    ].filter(Boolean).join('\n'));
    addPdfSection(doc, '四、违约成本分析（仅供参考）', reviewData.breach_cost_analysis || [], (item) => [
        item.scenario || '违约场景',
        item.legal_basis ? `法律依据：${item.legal_basis}` : '',
        item.estimated_cost ? `预计成本：${item.estimated_cost}` : '',
    ].filter(Boolean).join('\n'));
    addPdfSection(doc, '五、印章与签章核验', reviewData.seal_analysis || [], (item) => [
        item.seal_name || '签章检查',
        item.status ? `状态：${item.status}` : '',
        item.risk_level ? `风险等级：${item.risk_level}` : '',
        item.details || '',
    ].filter(Boolean).join('\n'));
    addPdfSection(doc, '六、法条与案例依据', reviewData.relevant_laws || [], (item) => [
        `${item.law || item.title || ''} ${item.clause || ''}`,
        item.content || '',
    ].filter(Boolean).join('\n'));
    addPdfSection(doc, '七、修改建议', reviewData.modification_suggestions || [], (item) => [
        item.title || item.clause || '修改建议',
        `原文：${item.original_text || item.original_clause || ''}`,
        `建议修改为：${item.suggested_text || item.modification || ''}`,
        `修改理由：${item.reason || item.rationale || ''}`,
    ].filter(Boolean).join('\n'));
    doc.end();
};

const ensureUploadUser = async (trx, userId) => {
    const numericUserId = Number(userId);
    if (!Number.isInteger(numericUserId) || numericUserId <= 0) {
        throw new Error('INVALID_USER_ID');
    }

    const existing = await trx('users').where({ id: numericUserId }).first();
    if (existing) return numericUserId;

    await trx('users')
        .insert({
            id: numericUserId,
            fingerprint_id: `legacy-upload-user-${numericUserId}`,
        })
        .onConflict('id')
        .ignore();

    return numericUserId;
};

const compactText = (value, maxLength = 4000) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

const LEGAL_TRIGGER_TERMS = [
    '应当', '不得', '有权', '义务', '责任', '赔偿',
    '解除', '终止', '保密', '管辖', '仲裁', '违约',
    '保证', '承诺', '担保', '授权', '许可', '限制',
    '禁止', '必须', '可以', '视为',
    '违约金', '损害赔偿', '知识产权', '社会保险',
    '竞业限制', '工资', '报酬', '股权', '期权',
    '质押', '抵押', '定金', '保证金', '留置',
    '通知', '送达', '争议', '诉讼', '继承',
    '罚款', '商标', '专利', '著作权', '商业秘密',
    '刑事责任', '连带', '免责', '不可抗力',
    '转让', '分包', '转包', '出租', '出售',
    '关联方', '披露', '陈述', '保证', '赔偿',
];

/**
 * 从合同文本中提取含法律关键词的句子，作为向量检索的聚焦查询
 * 替代原来的整段合同文本截取的方案，避免查询向量被稀释
 */
const extractLegalClauses = (text, maxClauses = 6) => {
    if (!text || !String(text).trim()) return [];
    const sentences = String(text)
        .replace(/\s+/g, ' ')
        .split(/(?<=[。；！？!?;])/g)
        .map((s) => s.trim())
        .filter((s) => s.length >= 15 && s.length <= 600);

    const scored = sentences.map((s) => ({
        text: s,
        score: LEGAL_TRIGGER_TERMS.reduce((sum, kw) => sum + (s.includes(kw) ? 1 : 0), 0),
    }));

    scored.sort((a, b) => b.score - a.score || b.text.length - a.text.length);

    const result = [];
    const seen = new Set();
    for (const item of scored) {
        if (result.length >= maxClauses) break;
        const key = item.text.slice(0, 30);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(item.text);
    }
    return result;
};

const buildKnowledgeSearchQuery = ({
    text = '',
    contractType = '',
    reviewPoints = [],
    corePurposes = [],
    question = '',
    perspective = '',
} = {}) => {
    const focusedTerms = [
        contractType,
        perspective ? `${perspective} 立场 风险 责任 权利义务` : '',
        ...reviewPoints,
        ...corePurposes,
        question,
    ].filter(Boolean).join('\n');

    // 从合同中提取含法律关键词的句子作为检索查询，替代原始合同文本截取
    // 这样每条查询语句都聚焦于一个具体的法律问题，而非整段噪音
    const legalClauses = extractLegalClauses(text, focusedTerms ? 6 : 10);
    const searchContext = legalClauses.length > 0
        ? legalClauses.join('\n')
        : compactText(text, focusedTerms ? 2000 : 4000);

    return [
        focusedTerms,
        searchContext,
    ].filter(Boolean).join('\n');
};

const getRelevantKnowledge = async (options, limit = 8) => {
    const query = typeof options === 'string'
        ? buildKnowledgeSearchQuery({ text: options })
        : buildKnowledgeSearchQuery(options);
    const matches = await searchVectorDocuments(query, {
        limit,
        sourceTypes: ['law', 'case', 'rule', 'guide'],
        rerank: true,
    });

    // 按 clause_id 去重：同一法条同一条号只保留 score 最高的一个
    // 避免 LLM prompt 中出现 "第XX条...第XX条..." 重复引用
    const byClause = new Map();
    for (const item of matches) {
        const sourceKey = `${item.title}@@${item.clause_id || ''}`;
        const existing = byClause.get(sourceKey);
        const score = item.rerank_score ?? item.score ?? 0;
        if (!existing || score > (existing.rerank_score ?? existing.score ?? 0)) {
            byClause.set(sourceKey, item);
        }
    }

    return Array.from(byClause.values()).map((item) => ({
        source_type: item.source_type,
        law: item.title,
        clause: item.clause_id || item.source_id,
        content: item.content,
        score: item.rerank_score ?? item.score,
        source_name: item.source_name,
        source_url: item.source_url,
        metadata: item.metadata || {},
    }));
};

const annotateKnowledgeUpdates = (items) => items.map((item) => ({
    ...item,
    hasUpdate: false,
    updateNotice: '当前知识库未标记该依据存在更新；正式出具意见前仍应核对最新法律、司法解释和裁判文书。',
}));

// ============ 分节链式检索 (Step A) ============

/**
 * 智能合同分节：将合同文本按条款/章节/编号/自然段落拆分为 N 段
 * 返回 [{ index, title, content, type }]
 */
const splitContractIntoSections = (text) => {
    if (!text || !String(text).trim()) return [{ index: 0, title: '全文', content: String(text || ''), type: 'full' }];

    const raw = String(text);
    const lines = raw.split('\n');
    const sections = [];
    let current = { index: 0, title: '', content: '', type: 'para' };

    // 识别第X条、第X章、第X节、"X."编号、"X、"编号、或"（X）""【X】"标记
    const sectionPattern = /^\s*(第[一二三四五六七八九十百千\d]+[条章节])\s*[。\.\s]?(.*)$|^\s*(第[一二三四五六七八九十百千\d]+[条章节])\s*$/;
    // 段落编号模式: "X." "X、" "X、" "（X）" "【X】"
    const numberedPattern = /^\s*(\d+)\.\s+(.+)$|^\s*(\d+)[、．]\s*(.+)$|^\s*[（【\(]\s*(\d+)\s*[）】\)]\s*(.+)$/;
    // 连续自然段落合并阈值
    const MAX_PARA_LEN = 3000;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const sectionMatch = trimmed.match(sectionPattern);
        const numberedMatch = trimmed.match(numberedPattern);

        let isNewSection = false;
        let sectionTitle = '';
        let sectionContent = trimmed;

        if (sectionMatch) {
            // 匹配到"第X条 标题"或"第X条"
            sectionTitle = (sectionMatch[1] || sectionMatch[3] || '').trim();
            const rest = (sectionMatch[2] || '').trim();
            sectionContent = rest || trimmed;
            isNewSection = true;
        } else if (numberedMatch) {
            // 匹配到 "1. 标题" "2、标题" "（3）标题"
            const num = numberedMatch[1] || numberedMatch[3] || numberedMatch[5] || '';
            const title = numberedMatch[2] || numberedMatch[4] || numberedMatch[6] || '';
            sectionTitle = `${num}. ${title}`;
            isNewSection = true;
        } else if (current.content.length > MAX_PARA_LEN) {
            // 当前段落过长，强制切分
            isNewSection = true;
            sectionTitle = `段落${sections.length + 1}`;
        }

        if (isNewSection && current.content) {
            sections.push({ ...current });
            current = {
                index: sections.length,
                title: sectionTitle,
                content: sectionContent,
                type: sectionMatch ? 'clause' : (numberedMatch ? 'numbered' : 'para'),
            };
        } else if (isNewSection) {
            current.title = sectionTitle;
            current.content = sectionContent;
            current.type = sectionMatch ? 'clause' : (numberedMatch ? 'numbered' : 'para');
        } else {
            current.content += '\n' + trimmed;
        }
    }
    if (current.content) sections.push(current);

    // 如果分节太少（<=2），退回到按字数大致切分
    if (sections.length <= 2 && raw.length > 4000) {
        const roughChunks = [];
        const chunkSize = Math.ceil(raw.length / Math.ceil(raw.length / 2500));
        for (let i = 0; i < raw.length; i += chunkSize) {
            roughChunks.push({
                index: roughChunks.length,
                title: `段落${roughChunks.length + 1}`,
                content: raw.slice(i, i + chunkSize),
                type: 'para',
            });
        }
        return roughChunks;
    }

    return sections;
};

/**
 * 构造多个检索角度：从当前节内容 + 审查点推断 2~3 个不同查询
 */
const buildSectionQueries = (sectionContent, sectionTitle, reviewPoints) => {
    const queries = [];

    // 1. 从节文本中提取法律关键句（原 extractLegalClauses 逻辑）
    const legalSentences = extractLegalClauses(sectionContent, 5);
    if (legalSentences.length > 0) {
        queries.push(legalSentences.join('\n'));
    }

    // 2. 当前节标题 + 审查点聚焦
    const titleQuery = [sectionTitle, ...reviewPoints].filter(Boolean).join(' ');
    if (titleQuery.trim()) {
        queries.push(titleQuery);
    }

    // 3. 合同全文中法律关键词丰富度高的句子（从本节取 top-3 关键词句 + 邻近上下文）
    const expandedSentences = extractLegalClauses(sectionContent, 8).slice(0, 3);
    if (expandedSentences.length > 0) {
        queries.push(expandedSentences.join('\n'));
    }

    // 去重（简单模糊去重）
    const deduped = [];
    const seen = new Set();
    for (const q of queries) {
        const sig = q.replace(/\s+/g, '').slice(0, 60);
        if (!seen.has(sig)) {
            seen.add(sig);
            deduped.push(q);
        }
    }
    return deduped;
};

/**
 * 逐节 Multi-Query 知识检索 + 合并去重
 * 替代原来的单次 getRelevantKnowledge 调用
 */
const multiSectionKnowledgeRetrieval = async (plainText, options, perSectionLimit = 5, totalLimit = 24) => {
    const sections = splitContractIntoSections(plainText);
    const allResults = [];

    // 并行检索每节（控制并发数，避免 API 限流）
    const CONCURRENCY = 4;
    for (let i = 0; i < sections.length; i += CONCURRENCY) {
        const batch = sections.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(async (section) => {
            const sectionQueries = buildSectionQueries(
                section.content,
                section.title,
                options.reviewPoints || [],
            );

            if (sectionQueries.length === 0) return [];

            // 每条查询独立检索，结果合并
            const sectionMatches = [];
            const queriedQueries = sectionQueries.slice(0, 3); // 最多 3 个查询角度
            for (const query of queriedQueries) {
                const fullQuery = [
                    options.contractType || '',
                    options.perspective ? `${options.perspective} 立场 风险 责任 权利义务` : '',
                    query,
                ].filter(Boolean).join('\n');

                try {
                    const matches = await searchVectorDocuments(fullQuery, {
                        limit: perSectionLimit,
                        sourceTypes: ['law', 'case', 'rule', 'guide'],
                        rerank: true,
                    });
                    sectionMatches.push(...matches);
                } catch (err) {
                    console.warn(`[Section ${section.index}] Query failed:`, err.message);
                }
            }
            return sectionMatches;
        }));
        allResults.push(...batchResults.flat());
    }

    // 全局按 clause_id 去重（保留 score 最高的）
    const byClause = new Map();
    for (const item of allResults) {
        const sourceKey = `${item.title}@@${item.clause_id || ''}`;
        const existing = byClause.get(sourceKey);
        const score = item.rerank_score ?? item.score ?? 0;
        if (!existing || score > (existing.rerank_score ?? existing.score ?? 0)) {
            byClause.set(sourceKey, item);
        }
    }

    const merged = Array.from(byClause.values());
    // 按 score 排序
    merged.sort((a, b) => (b.rerank_score ?? b.score ?? 0) - (a.rerank_score ?? a.score ?? 0));

    return merged.slice(0, totalLimit).map((item) => ({
        source_type: item.source_type,
        law: item.title,
        clause: item.clause_id || item.source_id,
        content: item.content,
        score: item.rerank_score ?? item.score,
        source_name: item.source_name,
        source_url: item.source_url,
        metadata: item.metadata || {},
    }));
};

const runSealOcr = async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff'].includes(ext)) {
        return { text: '', supported: false, reason: '当前 OCR 需要 PDF 中提取出的印章图片，或直接上传印章区域图片。' };
    }

    const worker = await createWorker(process.env.SEAL_OCR_LANG || 'chi_sim+eng');
    try {
        const { data } = await worker.recognize(filePath);
        return { text: data?.text || '', confidence: data?.confidence || 0, supported: true };
    } finally {
        await worker.terminate();
    }
};

const analyzeSealAndSignature = async (contract, plainText) => {
    const companyNames = extractCompanyNames(plainText).slice(0, 3);
    try {
        const ocr = await runSealOcr(contract.storage_path);
        if (!ocr.supported) {
            return [{
                seal_name: companyNames[0] || '签章检查',
                status: '待核验',
                risk_level: '中',
                details: `${ocr.reason} 已识别合同主体候选：${companyNames.join('、') || '未识别到明确主体'}。请上传印章区域截图或使用电子签章平台核验。`,
            }];
        }

        const normalizedOcr = ocr.text.replace(/\s+/g, '');
        const matchedCompany = companyNames.find((name) => normalizedOcr.includes(String(name).replace(/\s+/g, '')));
        return [{
            seal_name: matchedCompany || companyNames[0] || '签章检查',
            status: matchedCompany ? '主体名称初步一致' : '待核验',
            risk_level: matchedCompany && ocr.confidence >= 60 ? '低' : '中',
            details: `OCR 置信度 ${Math.round(ocr.confidence || 0)}。${matchedCompany ? `印章文字与主体「${matchedCompany}」初步一致。` : `未在 OCR 文本中匹配到主体候选：${companyNames.join('、') || '无'}。`} OCR 文本摘要：${compactText(ocr.text, 300)}`,
        }];
    } catch (error) {
        return [{
            seal_name: companyNames[0] || '签章检查',
            status: '待核验',
            risk_level: '中',
            details: `OCR 识别未完成：${error.message}。主体候选：${companyNames.join('、') || '未识别到明确主体'}。`,
        }];
    }
};

const normalizeAnalysisResult = (result) => ({
    dispute_points: Array.isArray(result.dispute_points) ? result.dispute_points : [],
    missing_clauses: Array.isArray(result.missing_clauses) ? result.missing_clauses : [],
    party_review: Array.isArray(result.party_review) ? result.party_review : [],
    modification_suggestions: Array.isArray(result.modification_suggestions) ? result.modification_suggestions : [],
    breach_cost_analysis: Array.isArray(result.breach_cost_analysis) ? result.breach_cost_analysis : [],
    seal_analysis: Array.isArray(result.seal_analysis) ? result.seal_analysis : [],
    relevant_laws: Array.isArray(result.relevant_laws) ? result.relevant_laws : [],
    company_review: Array.isArray(result.company_review) ? result.company_review : [],
});

router.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const { userId, groupId } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID is required for upload.' });

    try {
        const contractRecord = await db.transaction(async (trx) => {
            const safeUserId = await ensureUploadUser(trx, userId);
            const originalFilenameDecoded = iconv.decode(Buffer.from(req.file.originalname, 'binary'), 'utf-8');
            const documentKey = uuidv4();
            const [newContract] = await trx('contracts').insert({
                user_id: safeUserId,
                original_filename: originalFilenameDecoded,
                storage_path: req.file.path,
                document_key: documentKey,
                group_id: groupId || null,
                status: 'Uploaded',
            }).returning(['id', 'original_filename', 'document_key', 'storage_path', 'user_id']);

            return newContract || await trx('contracts').where({ document_key: documentKey }).first();
        });
        const ext = path.extname(contractRecord.storage_path).toLowerCase().replace('.', '');
        res.status(201).json({
            message: '文件已上传，编辑器配置已生成。',
            contractId: contractRecord.id,
            editorConfig: buildOnlyOfficeConfig(contractRecord, ext),
        });
    } catch (error) {
        if (error.message === 'INVALID_USER_ID') {
            return res.status(400).json({ error: 'Invalid user ID for upload.' });
        }
        console.error('[ERROR] Error processing upload for OnlyOffice:', error);
        res.status(500).json({ error: 'Server error during file upload.' });
    }
});

router.post('/save-callback', async (req, res) => {
    try {
        const body = req.body;
        console.log('[OnlyOffice] save callback:', {
            status: body.status,
            key: body.key,
            hasUrl: Boolean(body.url),
            forcesavetype: body.forcesavetype,
        });
        if (body.status === 2 || body.status === 6) {
            const contract = await db('contracts').where({ document_key: body.key }).first();
            if (contract && body.url) {
                const response = await axios.get(body.url, { responseType: 'stream' });
                const writer = fs.createWriteStream(contract.storage_path);
                response.data.pipe(writer);
                await new Promise((resolve, reject) => {
                    writer.on('finish', resolve);
                    writer.on('error', reject);
                });
                await db('contracts').where({ id: contract.id }).update({ updated_at: db.fn.now() });
                console.log(`[OnlyOffice] saved file for contract ${contract.id} from status ${body.status}`);
            } else {
                console.warn('[OnlyOffice] save callback skipped: contract or download url missing');
            }
        }
        res.status(200).json({ error: 0 });
    } catch (error) {
        console.error('[ERROR] Save callback failed:', error);
        res.status(200).json({ error: 0 });
    }
});

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

router.post('/pre-analyze', async (req, res) => {
    const { contractId } = req.body;
    if (!contractId) return res.status(400).json({ error: 'Contract ID is required.' });
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const contract = await findOwnedContract(contractId, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        let plainText;
        try {
            plainText = await extractTextFromFile(contract.storage_path);
        } catch (extractError) {
            if (extractError.code === 'SCANNED_PDF') {
                return res.status(422).json({
                    error: extractError.message,
                    code: 'SCANNED_PDF',
                    scanInfo: extractError.scanInfo,
                });
            }
            if (extractError.code === 'EMPTY_TEXT') {
                return res.status(422).json({
                    error: extractError.message,
                    code: 'EMPTY_TEXT',
                });
            }
            throw extractError;
        }

        // 提供文本字数与预览，让用户确认解析是否正确（issue 1.4）
        const textPreview = String(plainText).replace(/\s+/g, ' ').trim().slice(0, 200);
        const textStats = {
            charCount: String(plainText).length,
            preview: textPreview,
        };

        await emitAnalysisProgress(req, contractId, { step: 'pre_analysis', status: 'running', message: '正在进行合同预分析。' });
        const prompt = `你是专业法务助手。阅读合同后只输出 JSON：
{
  "contract_type": "合同类型",
  "potential_parties": ["可选审查立场"],
  "suggested_review_points": ["关键审查点"],
  "suggested_core_purposes": ["核心审查目的"]
}

要求：
- 审查点和目的必须具体，优先贴合合同类型。
- 不输出自然语言解释。

合同原文：
---
${wrapContractContent(plainText)}
---`;
        const analysisResult = await callJsonLLM(prompt);
        const template = matchTemplate(analysisResult.contract_type, plainText);
        analysisResult.template_id = template?.id || 'general';
        analysisResult.template_name = template?.name || '通用合同审查模板';
        analysisResult.available_templates = undefined;
        analysisResult.suggested_review_points = Array.from(new Set([
            ...(template?.review_points || []),
            ...(analysisResult.suggested_review_points || []),
        ]));
        analysisResult.suggested_core_purposes = Array.from(new Set([
            ...(template?.core_purposes || []),
            ...(analysisResult.suggested_core_purposes || []),
        ]));
        analysisResult.text_stats = textStats;

        await db('contracts').where({ id: contractId }).update({
            status: 'PreAnalyzed',
            analysis_status: 'pre_analyzed',
            pre_analysis_data: JSON.stringify(analysisResult),
        });
        await emitAnalysisProgress(req, contractId, { step: 'pre_analysis', status: 'completed', message: '合同预分析已完成。', partialResult: { preAnalysisData: analysisResult } });
        res.json(analysisResult);
    } catch (error) {
        console.error(`[ERROR] Pre-analysis failed for contract ${contractId}:`, error);
        res.status(500).json({ error: '预分析失败，请稍后重试。' });
    }
});

// ============ 逐节结果合并工具 (Step B + C) ============

/**
 * 将两节审查结果合并，按标题去重 + 跨段线索记入附加信息
 */
const mergeSectionResults = (acc, current, clues) => {
    const result = {
        dispute_points: [...(acc.dispute_points || [])],
        missing_clauses: [...(acc.missing_clauses || [])],
        party_review: [...(acc.party_review || [])],
        modification_suggestions: [...(acc.modification_suggestions || [])],
        breach_cost_analysis: [...(acc.breach_cost_analysis || [])],
    };

    // 添加新发现的 dispute_points（按标题去重）
    for (const dp of (current.dispute_points || [])) {
        const exists = result.dispute_points.some(
            (e) => e.title === dp.title || (dp.title && e.title && e.title.includes(dp.title.slice(0, 10))),
        );
        if (!exists) result.dispute_points.push(dp);
    }

    // 添加缺失条款（直接合并，一般不会重复）
    for (const mc of (current.missing_clauses || [])) {
        result.missing_clauses.push(mc);
    }

    // 添加主体审查（去重）
    for (const pr of (current.party_review || [])) {
        const exists = result.party_review.some(
            (e) => e.title === pr.title,
        );
        if (!exists) result.party_review.push(pr);
    }

    // 添加修改建议（按 original_text 去重）
    for (const ms of (current.modification_suggestions || [])) {
        const exists = result.modification_suggestions.some(
            (e) => e.original_text && ms.original_text && e.original_text.slice(0, 30) === ms.original_text.slice(0, 30),
        );
        if (!exists) result.modification_suggestions.push(ms);
    }

    // 添加违约成本分析（按 scenario 去重）
    for (const bc of (current.breach_cost_analysis || [])) {
        const exists = result.breach_cost_analysis.some(
            (e) => e.scenario === bc.scenario,
        );
        if (!exists) result.breach_cost_analysis.push(bc);
    }

    return result;
};

/**
 * 全局去重合并 + 风险排序（用于综合会诊前的预清理）
 */
const deduplicateSectionResults = (merged) => {
    const result = {
        dispute_points: [],
        missing_clauses: [...(merged.missing_clauses || [])],
        party_review: [...(merged.party_review || [])],
        modification_suggestions: [],
        breach_cost_analysis: [...(merged.breach_cost_analysis || [])],
    };

    // dispute_points 按标题去重，保留最高 severity
    const dpMap = new Map();
    for (const dp of (merged.dispute_points || [])) {
        const key = (dp.title || '').replace(/\s+/g, '').slice(0, 20);
        const existing = dpMap.get(key);
        const severityOrder = { '高': 3, '中': 2, '低': 1 };
        if (!existing || (severityOrder[dp.severity] || 0) > (severityOrder[existing.severity] || 0)) {
            dpMap.set(key, dp);
        }
    }
    // 排序：高 → 中 → 低
    const severityPriority = { '高': 0, '中': 1, '低': 2 };
    result.dispute_points = Array.from(dpMap.values()).sort(
        (a, b) => (severityPriority[a.severity] || 99) - (severityPriority[b.severity] || 99),
    );

    // modification_suggestions 按 original_text 去重
    const msMap = new Map();
    for (const ms of (merged.modification_suggestions || [])) {
        const key = (ms.original_text || '').replace(/\s+/g, '').slice(0, 30);
        if (!msMap.has(key)) msMap.set(key, ms);
    }
    result.modification_suggestions = Array.from(msMap.values());

    return result;
};

// 后台异步执行合同审查（不阻塞 HTTP 响应）
const runAnalysisInBackground = async (contractId, userId, userPerspective, preAnalysisData) => {
    const contract = await findOwnedContract(contractId, userId);
    if (!contract) {
        await emitAnalysisProgress(null, contractId, { step: 'finalize', status: 'failed', message: '未找到合同记录。' });
        return;
    }

    try {
        // Step 1: 提取合同正文
        await emitAnalysisProgress(null, contractId, { step: 'extract_text', status: 'running', message: '正在提取合同正文...' });
        let plainText;
        try {
            plainText = await extractTextFromFile(contract.storage_path);
        } catch (extractError) {
            const errMsg = extractError.code === 'SCANNED_PDF'
                ? extractError.message
                : (extractError.code === 'EMPTY_TEXT' ? extractError.message : `合同正文提取失败：${extractError.message}`);
            await emitAnalysisProgress(null, contractId, { step: 'extract_text', status: 'failed', message: errMsg });
            return;
        }
        await emitAnalysisProgress(null, contractId, { step: 'extract_text', status: 'completed', message: `已提取合同正文（${String(plainText).length} 字）。` });

        const template = getTemplateById(preAnalysisData.template_id) || matchTemplate(preAnalysisData.contract_type, plainText);
        const reviewPoints = preAnalysisData.reviewPoints?.length ? preAnalysisData.reviewPoints : template.review_points;
        const corePurposes = preAnalysisData.core_purposes?.length ? preAnalysisData.core_purposes : template.core_purposes;

        // Step 2: 逐节 Multi-Query 知识检索（替代原来单次检索）
        await emitAnalysisProgress(null, contractId, { step: 'knowledge_search', status: 'running', message: '正在按合同结构逐节检索法条与案例依据（分节多角度检索，覆盖率更高）...' });
        const sections = splitContractIntoSections(plainText);
        await emitAnalysisProgress(null, contractId, { step: 'knowledge_search', status: 'running', message: `合同已分为 ${sections.length} 节，正在进行多角度知识检索...` });
        const relevantKnowledge = await multiSectionKnowledgeRetrieval(plainText, {
            contractType: preAnalysisData.contract_type,
            reviewPoints,
            corePurposes,
            perspective: userPerspective,
        });
        await emitAnalysisProgress(null, contractId, { step: 'knowledge_search', status: 'completed', message: `逐节 Multi-Query 知识检索已完成（${sections.length} 节 × 多角度查询，合并去重后 ${relevantKnowledge.length} 条依据）。`, partialResult: { relevant_laws: annotateKnowledgeUpdates(relevantKnowledge) } });

        // Step 3: 核验合同主体信息
        await emitAnalysisProgress(null, contractId, { step: 'company_search', status: 'running', message: '正在核验合同主体信息...' });
        const companyNames = extractCompanyNames(plainText).slice(0, 3);
        const companySearchResults = await Promise.all(
            companyNames.map((name) => searchCompanyInfo(name)),
        );
        await emitAnalysisProgress(null, contractId, { step: 'company_search', status: 'completed', message: `合同主体信息核验已完成（${companyNames.length} 个主体）。`, partialResult: { company_search: companySearchResults } });
        const companySearchContext = companySearchResults.map((company, index) => {
            const evidence = company.results.slice(0, 5).map((item, resultIndex) => (
                `${resultIndex + 1}. [${item.engine}] ${item.title} ${item.url} 可信度:${item.authenticity_score} ${item.verified ? '已通过初步真实性检测' : '未通过真实性检测'} 摘要:${item.snippet}`
            )).join('\n');
            return `${index + 1}. ${company.companyName}\n${evidence || '未检索到可用外部证据'}`;
        }).join('\n');

        // ========== Step B + C: 逐节链式审查 + 综合会诊 ==========
        await emitAnalysisProgress(null, contractId, { step: 'llm_review', status: 'running', message: `AI 正在逐节深度审查 ${sections.length} 个合同章节，每节独立聚焦，避免信息淹没...` });

        // 构造主体审查补充 prompt（供 fallback 使用）
        const subjectSearchPrompt = `

主体外部检索证据（来自 Bing/Baidu 搜索，已做基础真实性评分；只能把 verified=true 或可信度较高的结果作为主体审查线索，不能当作最终工商登记结论）：
${companySearchContext || '未识别到可检索的公司主体名称。'}

请额外输出 company_review 字段，结构为 [{"company_name":"公司名称","status":"已检索/未检索到可靠证据","evidence_summary":"基于外部搜索证据的主体核验摘要","authenticity":"真实性检测结论","sources":["URL"]}]。`;

        // 构建标准审查 JSON schema 说明
        const reviewSchemaDoc = `{
  "dispute_points": [{"title":"风险标题","original_clause":"合同原文","legal_reference":"依据","dispute_rationale":"风险说明","plain_language":"大白话说明","severity":"高/中/低"}],
  "missing_clauses": [{"title":"缺失条款","description":"为什么缺失","suggested_clause":"可补充条款"}],
  "party_review": [{"title":"主体审查项","description":"审查结论","plain_language":"大白话说明"}],
  "modification_suggestions": [{"title":"建议标题","original_text":"合同中可定位的完整原文句子或段落","suggested_text":"可直接替换 original_text 的完整文本","reason":"修改理由","plain_language":"大白话说明","anchor_hint":"用于定位的短语"}],
  "breach_cost_analysis": [{"scenario":"违约场景","legal_basis":"依据","estimated_cost":"预计成本"}]
}`;

        const sectionReviewRules = `硬性要求：
- modification_suggestions 每一项必须包含 original_text 和 suggested_text。
- original_text 必须尽量逐字摘录合同原文中的完整句子或段落，用于 OnlyOffice 定位、书签和批注锚点。
- 如果没有检索依据，不得编造法条或案例，只能说明"当前知识库未检索到直接依据"。
- 不输出自然语言解释，不输出 markdown。
- 每节审查仅针对当前节展示的合同段落，不要跨段审查。`;

        // 将全库依据按法条分配到各节
        const sectionKnowledgeMap = new Map();
        for (const lawItem of relevantKnowledge) {
            // 找到最匹配的节：法条 clause 或标题中含有关键词
            const lawTerms = `${lawItem.law} ${lawItem.clause || ''} ${lawItem.content}`;
            let bestSection = null;
            let bestScore = 0;
            for (const sec of sections) {
                const secText = `${sec.title} ${sec.content}`;
                let score = 0;
                // 法条 clause 号匹配节标题（如 第四条 ↔ "第四条"）
                if (lawItem.clause && secText.includes(lawItem.clause)) score += 3;
                // 法条标题匹配（如 民法典 ↔ "适用民法典"）
                if (lawItem.law && secText.includes(lawItem.law.replace(/^中华人民共和国/, '').slice(0, 8))) score += 2;
                // 关键词命中 — 扩展关键词列表，支持劳动法专用词
                const LABOR_KEYWORDS = [
                    '保密', '违约', '赔偿', '管辖', '仲裁', '诉讼', '知识产权', '产权',
                    '解除', '时效', '生效', '社保', '社会保险', '档案', '转移', '书面',
                    '口头', '加班', '工资', '试用', '竞业', '补偿', '福利', '工时',
                    '休假', '期限', '终止', '安全', '卫生', '变更', '辞职', '通知',
                    '送达', '培训', '服务期', '工伤', '职业病', '医疗保险', '住房',
                    '公积金', '经济补偿', '裁员', '罚款', '违纪', '损失', '连带',
                ];
                let termHits = 0;
                for (const kw of LABOR_KEYWORDS) {
                    if (secText.includes(kw) && (lawItem.content || '').includes(kw)) {
                        termHits += 1;
                    }
                }
                // 互补关键词匹配：合同节和法条中各含一个互补关键词（如合同写"口头"、法条写"书面"）
                // 当互补对是直接矛盾型（书面↔口头、十五日↔三十日）时权重更高
                const COMPLEMENTARY_PAIRS = [
                    { pair: ['书面', '口头'], weight: 5 },    // 法律规定书面，合同写口头 — 直接违法！最高权重
                    { pair: ['十五日', '三十日'], weight: 5 }, // 法律规定15日，合同写30日 — 直接违法！最高权重
                    { pair: ['乙方', '甲方'], weight: 2 },
                    { pair: ['上限', '下限'], weight: 3 },
                    { pair: ['不低于', '高于'], weight: 3 },
                    { pair: ['不得低于', '可以低于'], weight: 3 },
                ];
                for (const { pair: [a, b], weight } of COMPLEMENTARY_PAIRS) {
                    if (secText.includes(a) && (lawItem.content || '').includes(b)) termHits += weight;
                    if (secText.includes(b) && (lawItem.content || '').includes(a)) termHits += weight;
                }
                score += termHits;
                // 节标题与法条内容的语义邻近加权：当节内容中的关键词与法条内容中的关键词重叠>=3个，额外加分
                let sharedTermBonus = 0;
                const secKws = LABOR_KEYWORDS.filter(kw => secText.includes(kw));
                const lawKws = LABOR_KEYWORDS.filter(kw => (lawItem.content || '').includes(kw));
                const sharedCount = secKws.filter(kw => lawKws.includes(kw)).length;
                if (sharedCount >= 3) sharedTermBonus = 2;
                if (sharedCount >= 5) sharedTermBonus = 4;
                score += sharedTermBonus;
                if (score > bestScore) {
                    bestScore = score;
                    bestSection = sec;
                }
            }
            if (!bestSection) bestSection = sections[0]; // fallback to first section
            const key = bestSection.index;
            if (!sectionKnowledgeMap.has(key)) sectionKnowledgeMap.set(key, []);
            sectionKnowledgeMap.get(key).push(lawItem);
        }

        // 逐节 LLM 链式审查
        let chainContext = '';
        let accumulatedResult = null;

        for (let secIdx = 0; secIdx < sections.length; secIdx += 1) {
            const section = sections[secIdx];
            const sectionLaws = sectionKnowledgeMap.get(section.index) || [];
            // 每节至少保留 2 条法条、最多 5 条
            const perSectionKnowledge = sectionLaws.length > 5
                ? sectionLaws.slice(0, 5)
                : (sectionLaws.length === 0 && relevantKnowledge.length > 0
                    ? relevantKnowledge.slice(0, 2)
                    : sectionLaws);

            // ===== 关键词匹配过滤审查点：只为当前节注入相关审查点 =====
            // 构建节内容的关键词向量（提取关键名词）
            const sectionTextForFilter = `${section.title} ${section.content}`;
            const FILTER_KEYWORDS = [
                '主体','资格','合同期限','固定期限','无固定期限','岗位','职责','地点','试用期',
                '录用','薪酬','绩效','奖金','工资','加班','工时','社保','社会保险','住房','公积金',
                '竞业','保密','知识','产权','培训','服务期','违约金','解除','终止','补偿','赔偿',
                '规章','制度','告知','工作内容','工作地点','休息','休假','劳动报酬','计件','单价',
                '支付','福利','待遇','劳动保护','职业病','商业秘密','变更','续订','通知','送达',
                '争议','仲裁','诉讼','管辖','书面','口头',
            ];
            const sectionKeywords = new Set(
                FILTER_KEYWORDS.filter(kw => sectionTextForFilter.includes(kw))
            );
            // 每个审查点有关键词匹配才保留
            const filteredReviewPoints = reviewPoints.filter(rp => {
                const lower = rp;
                for (const kw of sectionKeywords) {
                    if (lower.includes(kw)) return true;
                }
                // 如果节有法条匹配，保留所有审查点中含该法条关键词的
                for (const lawItem of perSectionKnowledge) {
                    const lawText = `${lawItem.law} ${lawItem.clause || ''} ${lawItem.content}`;
                    for (const kw of sectionKeywords) {
                        if (lawText.includes(kw)) return true;
                    }
                }
                return false;
            });
            // 至少保留 3 个审查点（fallback：按法条和节内容关键词搜索匹配审查点）
            const finalReviewPoints = filteredReviewPoints.length >= 3
                ? filteredReviewPoints
                : (() => {
                    // 从法条内容提取关键词
                    const lawKeywords = new Set();
                    for (const lawItem of perSectionKnowledge) {
                        const lawText = `${lawItem.law} ${lawItem.clause || ''} ${lawItem.content}`;
                        for (const kw of FILTER_KEYWORDS) {
                            if (lawText.includes(kw)) lawKeywords.add(kw);
                        }
                    }
                    // 用节+法条关键词再过滤
                    const allKeywords = new Set([...sectionKeywords, ...lawKeywords]);
                    const extended = reviewPoints.filter(rp => {
                        for (const kw of allKeywords) {
                            if (rp.includes(kw)) return true;
                        }
                        return false;
                    });
                    // 只要有关联的审查点就用关联的，只有0时才fallback取前3个
                    return extended.length >= 1 ? extended : reviewPoints.slice(0, 3);
                })();

            // 审查目的同理按关键词过滤
            const filteredPurposes = corePurposes.filter(cp => {
                for (const kw of sectionKeywords) {
                    if (cp.includes(kw)) return true;
                }
                for (const lawItem of perSectionKnowledge) {
                    const lawText = `${lawItem.law} ${lawItem.clause || ''} ${lawItem.content}`;
                    for (const kw of sectionKeywords) {
                        if (lawText.includes(kw)) return true;
                    }
                }
                return false;
            });
            const finalPurposes = filteredPurposes.length >= 1
                ? filteredPurposes
                : corePurposes.slice(0, 1);

            const sectionLabel = `${section.title || `段落 ${section.index + 1}`}`;
            await emitAnalysisProgress(null, contractId, {
                step: 'llm_review', status: 'running',
                message: `逐节审查: 第 ${secIdx + 1}/${sections.length} 节「${sectionLabel}」...`,
            });

            const sectionPrompt = `你是一名资深法务专家，请逐节审查合同。当前正在审查第 ${secIdx + 1} 节「${sectionLabel}」。

审查模板：
- 模板名称：${template.name}
- 合同类型：${preAnalysisData.contract_type}
- 用户立场：${userPerspective}
- 本节审查重点：${finalReviewPoints.join('；')}
- 审查目的：${finalPurposes.join('；')}
- 模板规则：${(template.prompt_rules || []).join('；')}

法律法规依据（仅限以下，不得虚构）：
${perSectionKnowledge.map((item, i) => `[${i + 1}] [${item.source_type}] ${item.law} ${item.clause || ''}：${item.content}`).join('\n') || '未检索到与本节直接相关的法条依据——仅在确认确实有关联时引用知识库已有法条，否则标注"当前知识库未检索到直接依据"。'}

${chainContext ? `前序章节已发现的关联风险（供参考，避免重复）：\n${chainContext}\n` : ''}

本节合同原文：
---
${wrapContractContent(section.content)}
---

输出 JSON 结构（只输出本节相关的审查结论，inter_section_clues 为保留给综合会诊的跨段线索）：
${reviewSchemaDoc}

JSON 中额外添加 inter_section_clues 字段记录：
- 跨段引用关系（如本条提到"详见第X条"）
- 需要与其它条款对比的数值（赔偿上限、违约金比例等）
- 本节与已有分析潜在冲突点

${sectionReviewRules}`;

            try {
                const sectionResult = await callJsonLLM(sectionPrompt);
                const normalized = normalizeAnalysisResult(sectionResult);

                // 收集跨段线索
                const clues = Array.isArray(sectionResult.inter_section_clues) ? sectionResult.inter_section_clues : [];
                if (clues.length > 0) {
                    chainContext += `\n第 ${secIdx + 1} 节「${sectionLabel}」跨段线索：${clues.map((c) => String(c).slice(0, 200)).join('；')}\n`;
                }

                // 合并到累积结果
                if (!accumulatedResult) {
                    accumulatedResult = normalized;
                } else {
                    accumulatedResult = mergeSectionResults(accumulatedResult, normalized, clues);
                }
            } catch (secError) {
                console.warn(`[Section ${secIdx}] LLM review failed for "${sectionLabel}":`, secError.message);
                // 单节失败不阻断整体，继续下一节
            }
        }

        // 如果没有成功审查任何节，回退到全篇一次审查
        if (!accumulatedResult) {
            console.warn('[Step B] All section reviews failed, falling back to full-text single review');
            const fallbackPrompt = `你是一名资深法务专家，请按审查模板对合同进行深度审查，并只输出 JSON。

审查模板：
- 模板名称：${template.name}
- 合同类型：${preAnalysisData.contract_type}
- 用户立场：${userPerspective}
- 审查点：${reviewPoints.join('；')}
- 审查目的：${corePurposes.join('；')}
- 模板规则：${(template.prompt_rules || []).join('；')}
- 报告结构偏好：${(template.report_sections || []).join('；')}

法律与裁判依据（向量 RAG + rerank 检索结果，只能引用以下内容，不得虚构法条、案号或裁判观点）：
${relevantKnowledge.map((item, index) => `[${index + 1}] [${item.source_type}] ${item.law} ${item.clause || ''}：${item.content}`).join('\n') || '未检索到直接依据。'}

输出 JSON 结构：
${reviewSchemaDoc}

${sectionReviewRules}

合同原文：
---
${wrapContractContent(plainText)}
---`;
            accumulatedResult = normalizeAnalysisResult(await callJsonLLM(fallbackPrompt + subjectSearchPrompt));
        }

        // ========== Step C: 综合会诊 ==========
        await emitAnalysisProgress(null, contractId, { step: 'llm_review', status: 'running', message: '正在综合会诊——去重合并、跨段一致性检查、风险排序...' });

        // 去重合并（按标题相似度去重 + 保留最高严重度）
        const deduplicated = deduplicateSectionResults(accumulatedResult);

        // 跨段一致性检查 — 第三阶段 LLM 综合会诊
        const crossSectionContext = chainContext || '无明显跨段关注点。';
        const synthesisPrompt = `你是一名资深法务专家，负责将逐节审查结果做最终的跨段一致性会诊。

审查模板：${template.name}
合同类型：${preAnalysisData.contract_type}
用户立场：${userPerspective}

逐节审查汇聚的跨段线索：
${crossSectionContext}

已发现的全部风险点（${deduplicated.dispute_points.length} 项）：
${JSON.stringify(deduplicated.dispute_points.slice(0, 20), null, 2)}

缺失条款（${deduplicated.missing_clauses.length} 项）：
${JSON.stringify(deduplicated.missing_clauses.slice(0, 10), null, 2)}

修改建议（${deduplicated.modification_suggestions.length} 项）：
${JSON.stringify(deduplicated.modification_suggestions.slice(0, 10), null, 2)}

违约成本分析（${deduplicated.breach_cost_analysis.length} 项）：
${JSON.stringify(deduplicated.breach_cost_analysis.slice(0, 5), null, 2)}

综合会诊任务：
1. 检查跨段一致性：不同章节中对同一事项（赔偿比例、管辖、价格等）的规定是否矛盾
2. 检查交叉引用：合同各条款之间的相互引用是否匹配
3. 修复优先级：将所有风险按严重程度重新排序，高风险置顶
4. 补充跨段发现的全局性风险（各节单独审查时无法发现的跨章节矛盾）
5. 最终输出去重、排序、补充后的完整 JSON

输出 JSON 结构：
${reviewSchemaDoc}

${sectionReviewRules}

注意：保留原有内容，只做增补、排序和去重。不要丢失任何已有发现。`;

        let finalAnalysis;
        try {
            finalAnalysis = normalizeAnalysisResult(await callJsonLLM(synthesisPrompt));
        } catch (synthError) {
            console.warn('[Step C] Synthesis LLM call failed, using deduplicated results:', synthError.message);
            finalAnalysis = deduplicated;
        }

        // 补充非审查结论字段
        finalAnalysis.relevant_laws = annotateKnowledgeUpdates(relevantKnowledge);
        finalAnalysis.template = {
            id: template.id,
            name: template.name,
            report_sections: template.report_sections || [],
        };

        // 主体审查（同原有逻辑，注入到结果中）
        const analysisResult = finalAnalysis;
        analysisResult.company_search = companySearchResults;
        if (!analysisResult.company_review.length && companySearchResults.length) {
            analysisResult.company_review = companySearchResults.map((company) => ({
                company_name: company.companyName,
                status: company.verifiedResults.length ? '已检索到可初步核验的主体线索' : '未检索到足够可靠的主体证据',
                evidence_summary: company.verifiedResults[0]?.snippet || company.results[0]?.snippet || '外部搜索未返回足够证据。',
                authenticity: company.verifiedResults.length ? '存在官方或多源交叉线索，仍需以国家企业信用信息公示系统等正式渠道为准。' : '搜索结果未通过基础真实性检测，不能据此下结论。',
                sources: (company.verifiedResults.length ? company.verifiedResults : company.results).slice(0, 3).map((item) => item.url),
            }));
        }

        await emitAnalysisProgress(null, contractId, { step: 'llm_review', status: 'completed', message: `逐节链式审查完成：${sections.length} 节逐节分析 + 综合会诊。` });

        // Step 5: 印章与签章核验
        await emitAnalysisProgress(null, contractId, { step: 'seal_analysis', status: 'running', message: '正在进行印章与签章核验...' });
        analysisResult.seal_analysis = analysisResult.seal_analysis.length
            ? analysisResult.seal_analysis
            : await analyzeSealAndSignature(contract, plainText);
        await emitAnalysisProgress(null, contractId, { step: 'seal_analysis', status: 'completed', message: '印章与签章核验已完成。' });

        // Step 6: 保存结果
        await emitAnalysisProgress(null, contractId, { step: 'finalize', status: 'running', message: '正在保存审查结果...' });
        await db('contracts').where({ id: contractId }).update({
            status: 'Reviewed',
            analysis_status: 'reviewed',
            analysis_result: JSON.stringify(analysisResult),
            analysis_partial_result: JSON.stringify(analysisResult),
            pre_analysis_data: JSON.stringify(preAnalysisData),
            perspective: userPerspective,
        });

        updateAnalysisJob(contractId, { status: 'completed', result: analysisResult, percent: 100 });
        await emitAnalysisProgress(null, contractId, { step: 'finalize', status: 'completed', message: '审查结果已保存。', partialResult: analysisResult });
        if (ioInstance) ioInstance.to(`contract-${contractId}`).emit('analysis-complete', { results: analysisResult, perspective: userPerspective });
    } catch (error) {
        console.error('Error during background AI analysis:', error);
        updateAnalysisJob(contractId, { status: 'failed', error: error.message });
        await emitAnalysisProgress(null, contractId, { step: 'failed', status: 'failed', message: `分析失败：${error.message}` });
        if (ioInstance) ioInstance.to(`contract-${contractId}`).emit('analysis-failed', { error: error.message });
    }
};

router.post('/analyze', async (req, res) => {
    const { contractId, userPerspective, preAnalysisData } = req.body;
    if (!contractId || !userPerspective || !preAnalysisData?.contract_type) {
        return res.status(400).json({ error: 'Incomplete analysis request. A full preAnalysisData object is required.' });
    }
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const contract = await findOwnedContract(contractId, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        // 若该合同已有正在运行的分析任务，拒绝重复触发
        const existingJob = analysisJobs.get(Number(contractId));
        if (existingJob && existingJob.status === 'running') {
            return res.status(409).json({ error: '该合同正在分析中，请等待当前分析完成。', jobId: existingJob.jobId });
        }

        // 创建分析任务并立即返回 jobId，后台异步执行
        const job = createAnalysisJob(contractId, userId);
        await db('contracts').where({ id: contractId }).update({
            analysis_status: 'analyzing',
            updated_at: db.fn.now(),
        });

        // 立即响应，不等分析完成
        res.status(202).json({
            jobId: job.jobId,
            contractId: Number(contractId),
            message: '分析任务已启动，请通过实时进度追踪查看状态。',
            steps: ANALYSIS_STEPS.map((s) => ({ key: s.key, label: s.label, weight: s.weight })),
            estimatedTotalSeconds: TOTAL_EST_SECONDS,
        });

        // 后台异步执行（不 await）
        runAnalysisInBackground(contractId, userId, userPerspective, preAnalysisData).catch((err) => {
            console.error('[ANALYSIS] Background task crashed:', err);
        });
    } catch (error) {
        console.error('Error starting AI analysis:', error);
        res.status(500).json({ error: '启动分析任务失败。' });
    }
});

// 查询分析任务状态（用于断线恢复）
router.get('/analyze-status/:contractId', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const contractId = Number(req.params.contractId);
    const job = analysisJobs.get(contractId);

    // 若内存任务不存在，回退到数据库状态
    if (!job) {
        const contract = await findOwnedContract(contractId, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });
        const hasResult = Boolean(contract.analysis_result);
        return res.json({
            contractId,
            status: hasResult ? 'completed' : (contract.analysis_status || 'idle'),
            percent: hasResult ? 100 : 0,
            steps: ANALYSIS_STEPS.map((s) => ({ ...s, status: hasResult ? 'completed' : 'pending', message: '' })),
            result: hasResult ? parseJsonField(contract.analysis_result, null) : null,
        });
    }

    res.json({
        contractId,
        jobId: job.jobId,
        status: job.status,
        percent: job.percent,
        currentStep: job.currentStep,
        elapsedSeconds: Math.round((Date.now() - job.startedAt) / 1000),
        steps: job.steps,
        error: job.error,
        result: job.result,
    });
});

router.post('/review-text', async (req, res) => {
    const { text, question, perspective, contractType, templateId, contractId } = req.body;
    if (!text || !String(text).trim()) return res.status(400).json({ error: 'Text is required for focused review.' });

    try {
        const template = getTemplateById(templateId) || matchTemplate(contractType || '', text);
        const relevantKnowledge = await getRelevantKnowledge({
            text,
            contractType: contractType || template.name,
            reviewPoints: template.review_points || [],
            corePurposes: template.core_purposes || [],
            question,
            perspective,
        }, 6);
        const prompt = `你是专业合同审查助手。用户选中了合同中的一段文本，请进行专项审查，只输出 JSON。

审查模板：${template.name}
审查立场：${perspective || '未指定'}
专项问题：${question || '识别该段文本的法律风险、可修改点，并给出可替换文本。'}

可引用依据（只能引用以下内容，不得虚构）：
${relevantKnowledge.map((item, index) => `[${index + 1}] [${item.source_type}] ${item.law} ${item.clause || ''}：${item.content}`).join('\n') || '未检索到直接依据。'}

待审查文本：
---
${wrapContractContent(text)}
---

输出 JSON：
{
  "risk_summary": "风险结论",
  "suggested_text": "可直接替换原文的完整文本；如无需修改则为空字符串",
  "reason": "专业理由",
  "plain_language": "大白话说明",
  "citations": [{"source_type":"law/case","title":"依据名称","clause":"条号或片段","content":"引用内容"}]}`;
        const parsed = await callJsonLLM(prompt);
        parsed.relevant_laws = annotateKnowledgeUpdates(relevantKnowledge);

        // 持久化到数据库（如果提供了 contractId）
        const numericContractId = Number(contractId);
        if (Number.isInteger(numericContractId) && numericContractId > 0) {
            const userId = getRequestUserId(req);
            try {
                const [inserted] = await db('focused_reviews').insert({
                    contract_id: numericContractId,
                    user_id: userId,
                    source_text: String(text),
                    question: question || null,
                    perspective: perspective || null,
                    contract_type: contractType || null,
                    template_id: templateId || null,
                    result: JSON.stringify(parsed),
                }).returning('id');
                parsed.focused_review_id = typeof inserted === 'object' ? inserted.id : inserted;
                parsed.saved_at = new Date().toISOString();
            } catch (saveError) {
                console.warn('[WARN] Failed to persist focused review:', saveError.message);
            }
        }

        res.json(parsed);
    } catch (error) {
        console.error('[ERROR] Focused review failed:', error);
        res.status(500).json({ error: 'Focused review failed.' });
    }
});

// 获取某合同的专项审查历史
router.get('/:id/focused-reviews', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    try {
        const contract = await findOwnedContract(req.params.id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        const rows = await db('focused_reviews')
            .where({ contract_id: Number(req.params.id) })
            .orderBy('created_at', 'desc')
            .limit(50)
            .select('id', 'source_text', 'question', 'perspective', 'contract_type', 'result', 'created_at');

        const items = rows.map((row) => {
            let parsed;
            try { parsed = JSON.parse(row.result); } catch { parsed = {}; }
            return {
                id: row.id,
                source_text: row.source_text,
                question: row.question,
                perspective: row.perspective,
                contract_type: row.contract_type,
                result: parsed,
                created_at: row.created_at,
            };
        });
        res.json({ items });
    } catch (error) {
        console.error('[ERROR] List focused reviews failed:', error);
        res.status(500).json({ error: 'Failed to list focused reviews.' });
    }
});

// 删除某条专项审查记录
router.delete('/focused-reviews/:reviewId', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    try {
        const reviewId = Number(req.params.reviewId);
        if (!Number.isInteger(reviewId) || reviewId <= 0) {
            return res.status(400).json({ error: 'Invalid review id.' });
        }
        const deleted = await db('focused_reviews').where({ id: reviewId, user_id: userId }).del();
        if (!deleted) return res.status(404).json({ error: 'Focused review not found.' });
        res.json({ ok: true });
    } catch (error) {
        console.error('[ERROR] Delete focused review failed:', error);
        res.status(500).json({ error: 'Failed to delete focused review.' });
    }
});

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

// 追加缺失条款到 DOCX 文档末尾（issue 3.4）
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

// 支持任意两个版本对比（issue 5.5）
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

router.post('/:id/force-save', async (req, res) => {
    const userId = req.header('X-User-ID');
    const { documentKey } = req.body || {};
    if (!userId) return res.status(401).json({ error: 'User ID is required for access.' });

    try {
        const contract = await db('contracts').where({ id: req.params.id, user_id: userId }).first();
        if (!contract) return res.status(404).json({ error: 'Contract not found or you do not have permission to access it.' });
        const key = String(documentKey || contract.document_key || '').trim();
        if (!key) return res.status(400).json({ error: 'Document key is required for force-save.' });

        const result = await postOnlyOfficeCommand({
            c: 'forcesave',
            key,
        });

        if (result?.error && result.error !== 0) {
            return res.status(502).json({ error: `OnlyOffice force-save failed: ${result.error}`, result });
        }

        res.json({ ok: true, result });
    } catch (error) {
        console.error(`[ERROR] Failed to force-save contract ${req.params.id}:`, error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to trigger OnlyOffice force-save.' });
    }
});

router.get('/:id/wps-config', async (req, res) => {
    const { id } = req.params;
    const userId = req.header('X-User-ID');
    if (!userId) return res.status(401).json({ error: 'User ID is required.' });

    try {
        const contractRecord = await db('contracts').where({ id, user_id: userId }).first();
        if (!contractRecord) return res.status(404).json({ error: 'Contract not found.' });
        res.json(buildWpsConfig(contractRecord, userId));
    } catch (error) {
        console.error('[ERROR] Failed to fetch wps-config:', error);
        res.status(500).json({ error: 'Server error while fetching WPS config.' });
    }
});

router.get('/:id/editor-config', async (req, res) => {
    const { id } = req.params;
    const userId = req.header('X-User-ID');
    if (!userId) return res.status(401).json({ error: 'User ID is required for access.' });

    try {
        const contractRecord = await db('contracts').where({ id, user_id: userId }).first();
        if (!contractRecord) return res.status(404).json({ error: 'Contract not found or you do not have permission to access it.' });

        const ext = path.extname(contractRecord.storage_path).toLowerCase().replace('.', '') || 'docx';
        res.json({
            editorConfig: buildOnlyOfficeConfig(contractRecord, ext),
        });
    } catch (error) {
        console.error(`[ERROR] Failed to fetch fresh editor config for id ${id}:`, error);
        res.status(500).json({ error: 'Server error while fetching editor config.' });
    }
});

router.get('/:id', async (req, res) => {
    const { id } = req.params;
    const userId = req.header('X-User-ID');
    if (!userId) return res.status(401).json({ error: 'User ID is required for access.' });

    try {
        const contractRecord = await db('contracts').where({ id, user_id: userId }).first();
        if (!contractRecord) return res.status(404).json({ error: 'Contract not found or you do not have permission to access it.' });

        const ext = path.extname(contractRecord.storage_path).toLowerCase().replace('.', '') || 'docx';
        const preAnalysisData = contractRecord.pre_analysis_data ? JSON.parse(contractRecord.pre_analysis_data) : {};
        const reviewData = contractRecord.analysis_result
            ? JSON.parse(contractRecord.analysis_result)
            : parseJsonField(contractRecord.analysis_partial_result, {});
        res.json({
            contract: {
                id: contractRecord.id,
                original_filename: contractRecord.original_filename,
                editorConfig: buildOnlyOfficeConfig(contractRecord, ext),
            },
            preAnalysisData,
            reviewData,
            analysisStatus: contractRecord.analysis_status,
            perspective: contractRecord.perspective,
            selectedReviewPoints: preAnalysisData.reviewPoints || preAnalysisData.suggested_review_points || [],
            customPurposes: preAnalysisData.core_purposes ? preAnalysisData.core_purposes.map((value) => ({ value })) : [],
        });
    } catch (error) {
        console.error(`[ERROR] Failed to fetch contract details for id ${id}:`, error);
        res.status(500).json({ error: 'Server error while fetching contract details.' });
    }
});

router.delete('/:id', async (req, res) => {
    const { id } = req.params;
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    try {
        const contract = await findOwnedContract(id, userId);
        if (!contract) return res.status(404).json({ error: 'Contract not found, cannot delete.' });
        if (contract.storage_path) await fs.promises.unlink(contract.storage_path).catch(() => {});
        await db('contracts').where({ id, user_id: userId }).del();
        res.status(200).json({ message: 'Contract deleted successfully.' });
    } catch (error) {
        console.error(`[ERROR] Failed to delete contract with ID ${id}:`, error);
        res.status(500).json({ error: 'Failed to delete contract.' });
    }
});

router.get('/', async (req, res) => {
    const userId = req.header('X-User-ID');
    if (!userId) return res.status(401).json({ error: 'User ID is required to fetch history.' });

    try {
        const contracts = await db('contracts')
            .where({ user_id: userId })
            .whereNull('group_id')
            .select('id', 'original_filename', 'created_at', 'status', 'perspective', 'pre_analysis_data', 'analysis_result')
            .orderBy('created_at', 'desc');
        const groups = await db('contract_groups')
            .where({ user_id: userId })
            .select('id', 'name', 'created_at', 'updated_at', 'status')
            .orderBy('created_at', 'desc');

        const extractMeta = (contract) => {
            let contractType = '';
            try {
                const pre = typeof contract.pre_analysis_data === 'string'
                    ? JSON.parse(contract.pre_analysis_data) : contract.pre_analysis_data;
                contractType = pre?.contract_type || '';
            } catch { /* ignore */ }
            let riskCount = 0;
            try {
                const result = typeof contract.analysis_result === 'string'
                    ? JSON.parse(contract.analysis_result) : contract.analysis_result;
                riskCount = Array.isArray(result?.dispute_points) ? result.dispute_points.length : 0;
            } catch { /* ignore */ }
            return {
                contract_type: contractType,
                perspective: contract.perspective || '',
                risk_count: riskCount,
            };
        };

        const records = [
            ...contracts.map((contract) => ({
                id: contract.id,
                original_filename: contract.original_filename,
                created_at: contract.created_at,
                status: contract.status,
                record_type: 'contract',
                ...extractMeta(contract),
            })),
            ...groups.map((group) => ({
                id: group.id,
                original_filename: group.name,
                created_at: group.created_at,
                updated_at: group.updated_at,
                status: group.status || 'Reviewed',
                record_type: 'group',
                contract_type: '',
                perspective: '',
                risk_count: 0,
            })),
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
        res.json(records);
    } catch (error) {
        console.error(`[ERROR] Failed to fetch contract history for user ${userId}:`, error);
        res.status(500).json({ error: 'Failed to fetch contract history.' });
    }
});

module.exports = router;
module.exports.setIoInstance = setIoInstance;
module.exports.splitContractIntoSections = splitContractIntoSections;
module.exports.runAnalysisInBackground = runAnalysisInBackground;
module.exports.buildSectionQueries = buildSectionQueries;
module.exports.multiSectionKnowledgeRetrieval = multiSectionKnowledgeRetrieval;
