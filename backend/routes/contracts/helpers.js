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
    return { ...payload, token: jwt.sign(payload, ONLYOFFICE_JWT_SECRET) };
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
    const [{ next_version_no: nextVersionNo }] = await db('contract_versions')
        .where({ contract_id: contract.id })
        .max({ next_version_no: 'version_no' });
    const versionNo = Number(nextVersionNo || 0) + 1;
    const ext = path.extname(contract.storage_path).toLowerCase();
    const snapshotDir = path.join(__dirname, '..', 'uploads', 'versions');
    await fs.promises.mkdir(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `${contract.id}-v${versionNo}-${uuidv4()}${ext}`);
    await fs.promises.copyFile(contract.storage_path, snapshotPath);

    let plainText = '';
    try {
        plainText = await extractTextFromFile(contract.storage_path);
    } catch (error) {
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

const renderReviewReportHtml = (contract, reviewData = {}, format = 'html') => {
    const rows = (items = [], render) => items.map(render).join('\n') || '<p>暂无数据。</p>';
    const severityCount = (points = []) => {
        const counts = { 高: 0, 中: 0, 低: 0 };
        points.forEach((p) => {
            const sev = String(p.severity || '').trim();
            if (counts[sev] !== undefined) counts[sev] += 1;
            else counts[中] += 1;
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

    await trx.raw("select setval(pg_get_serial_sequence('users', 'id'), greatest((select coalesce(max(id), 0) from users), 1), true)");
    return numericUserId;
};

const compactText = (value, maxLength = 4000) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);

// 通道 A「审查维度」query 构建：合同类型+立场、每个审查点、每个核心目的、用户问题
// 这些是法律语言，与法条同语言空间，embedding 匹配精度高，是召回主力
// 合同正文不进通道 A（合同语言会稀释法律意图），改由通道 B 独立召回
const buildChannelAQueries = ({
    contractType = '',
    reviewPoints = [],
    corePurposes = [],
    question = '',
    perspective = '',
} = {}) => {
    const queries = [];
    const perspectiveSuffix = perspective ? `${perspective} 立场` : '';

    if (contractType || perspectiveSuffix) {
        queries.push([
            contractType,
            perspectiveSuffix || '法律 风险 责任 权利义务',
        ].filter(Boolean).join(' '));
    }

    (reviewPoints || []).forEach((point) => {
        queries.push([
            contractType,
            point,
            perspectiveSuffix,
        ].filter(Boolean).join(' '));
    });

    (corePurposes || []).forEach((purpose) => {
        queries.push([
            contractType,
            purpose,
        ].filter(Boolean).join(' '));
    });

    if (question) queries.push(String(question).trim());

    return queries.filter(Boolean);
};

// 通道 B（合同内容）强阈值：只保留高置信命中，避免合同语言捞到弱相关法条噪声
const CHANNEL_B_SCORE_THRESHOLD = 0.7;

// 把向量检索结果映射为对外披露的 relevantKnowledge 项
const toRelevantKnowledgeItem = (item) => ({
    source_type: item.source_type,
    law: item.title,
    clause: item.clause_id || item.source_id,
    content: item.content,
    score: item.rerank_score ?? item.score,
    source_name: item.source_name,
    source_url: item.source_url,
    metadata: item.metadata || {},
});

// 置信加权融合：通道 A（审查维度）与通道 B（合同内容）同时命中的法条置信最高，优先保留并加分
// 仅 A 或仅 B 命中的项按分数排序在后；去重按 content_hash/source_id
const mergeChannelsWithConfidence = (channelA, channelB, limit) => {
    const getKey = (item) => item.content_hash || item.source_id || item.id;
    const scoreOf = (item) => item.rerank_score ?? item.score ?? 0;
    const merged = new Map();

    for (const item of channelA) {
        merged.set(getKey(item), { ...item, channel: 'A', confidence_boost: false });
    }
    for (const item of channelB) {
        const key = getKey(item);
        const existing = merged.get(key);
        if (existing) {
            // 两通道同时命中：置信最高，加分并标记
            existing.confidence_boost = true;
            const maxScore = Math.max(scoreOf(existing), scoreOf(item));
            existing.rerank_score = maxScore + 0.05;
            existing.score = maxScore;
        } else {
            merged.set(key, { ...item, channel: 'B', confidence_boost: false });
        }
    }

    return [...merged.values()]
        .sort((a, b) => {
            if (a.confidence_boost !== b.confidence_boost) return a.confidence_boost ? -1 : 1;
            return scoreOf(b) - scoreOf(a);
        })
        .slice(0, limit);
};

// 知识库检索：分通道召回 + 配额融合
//   通道 A「审查维度」法律语言，主力，占 2/3 配额，每条 query 召回 3 条
//   通道 B「合同内容」捞审查点未覆盖的非常规条款，补充，占 1/3 配额，每条 query 仅 top-1 且强阈值
// CONTRACT_CHUNK_MAX > 0 时限制通道 B 的 chunk 数，控制长合同检索成本
const getRelevantKnowledge = async (options, limit = 8) => {
    const sourceTypes = ['law', 'case', 'rule', 'guide'];

    // 字符串入口（纯文本）：单通道，按段落归并检索
    if (typeof options === 'string') {
        const queries = splitIntoParagraphGroups(options, { groupSize: 2, maxChars: 500, minChars: 5 });
        const matches = await searchVectorDocumentsMulti(queries, {
            limit,
            sourceTypes,
            rerank: true,
        });
        return matches.map(toRelevantKnowledgeItem);
    }

    const channelAQueries = buildChannelAQueries(options);
    let channelBQueries = splitIntoParagraphGroups(options.text || '', { groupSize: 2, maxChars: 500, minChars: 5 });
    if (CONTRACT_CHUNK_MAX > 0) channelBQueries = channelBQueries.slice(0, CONTRACT_CHUNK_MAX);

    const quotaA = Math.max(1, Math.round((limit * 2) / 3));
    const quotaB = Math.max(0, limit - quotaA);

    const [channelA, channelB] = await Promise.all([
        channelAQueries.length
            ? searchVectorDocumentsMulti(channelAQueries, {
                limit: quotaA,
                sourceTypes,
                rerank: true,
                perQueryLimit: 3,
            })
            : Promise.resolve([]),
        (channelBQueries.length && quotaB > 0)
            ? searchVectorDocumentsMulti(channelBQueries, {
                limit: quotaB,
                sourceTypes,
                rerank: true,
                perQueryLimit: 1,
                scoreThreshold: CHANNEL_B_SCORE_THRESHOLD,
            })
            : Promise.resolve([]),
    ]);
    
    return mergeChannelsWithConfidence(channelA, channelB, limit).map(toRelevantKnowledgeItem);
};

const annotateKnowledgeUpdates = (items) => items.map((item) => ({
    ...item,
    hasUpdate: false,
    updateNotice: '当前知识库未标记该依据存在更新；正式出具意见前仍应核对最新法律、司法解释和裁判文书。',
}));

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

// 兜底检测：扫描合同原文，补充 LLM 可能遗漏的典型霸王条款
const supplementKnownRiskPatterns = (analysisResult, plainText) => {
    if (!plainText || typeof plainText !== 'string') return;
    const points = analysisResult.dispute_points || [];

    // 已有的原文片段（去重）
    const existingClauses = new Set(
        points.map(p => (p.original_clause || '').replace(/\s+/g, '').slice(0, 30))
    );

    // 典型霸王条款规则列表
    const riskPatterns = [
        {
            keywords: ['解释权归', '解释权归甲方', '解释权归公司', '最终解释权'],
            title: '单方解释权条款（霸王条款）',
            legal_reference: '《民法典》第六条（公平原则）、第七条（诚信原则）；《中华人民共和国劳动合同法》第三条（公平原则）',
            dispute_rationale: '"单方解释权"赋予用人单位对合同条款的最终解释权，劳动者无法对条款含义提出异议，违反合同公平原则，属于典型格式霸王条款。',
            plain_language: '这条款说"最终解释权归公司"，意味着公司可以随便解读合同内容，劳动者说了不算，这是不公平的。',
            severity: '高',
        },
        {
            keywords: ['无偿解除', '无偿解除合同', '无偿辞退', '不支付任何补偿解除'],
            title: '无偿违法解除条款',
            legal_reference: '《中华人民共和国劳动合同法》第四十六条（经济补偿）、第四十八条（违法解除赔偿）',
            dispute_rationale: '用人单位违法解除或终止劳动合同须支付赔偿金，约定"无偿解除"违反法律规定，该条款无效。',
            plain_language: '合同写公司可以"无偿开除"你，但法律不允许这样做，被违法开除可以要求2N赔偿金。',
            severity: '高',
        },
        {
            keywords: ['限制结婚', '限制生育', '不得结婚', '不得生育'],
            title: '限制结婚生育条款（违法）',
            legal_reference: '《中华人民共和国劳动合同法》第三条；《就业促进法》第二十七条；《妇女权益保障法》第四十四条',
            dispute_rationale: '用人单位不得规定女职工在孕产哺乳期解除劳动合同，或限制其结婚生育，此类条款违法且无效。',
            plain_language: '合同规定不能结婚生孩子，这是违法的，公司不能用这个理由开除你。',
            severity: '高',
        },
        {
            keywords: ['保管责任', '丢失赔偿', '损坏赔偿', '乙方承担全部责任'],
            title: '不合理财产保管责任',
            legal_reference: '《中华人民共和国劳动合同法》第九条（不得扣押证件/要求担保）',
            dispute_rationale: '要求劳动者对工作场所所有丢失/损坏承担赔偿责任，超出合理范围，属于不公平格式条款。',
            plain_language: '合同规定丢了东西要全额赔，但如果是工作场所公共区域或者非你直接导致的丢失，不应该全赔。',
            severity: '中',
        },
        {
            keywords: ['加班必须', '强制加班', '拒绝加班视为', '不服从加班'],
            title: '强制加班且拒绝即违纪',
            legal_reference: '《中华人民共和国劳动法》第四十一条（加班上限）、第四十三条（支付加班费）',
            dispute_rationale: '用人单位不得强制加班，员工有权拒绝超时加班。将拒绝加班列为"严重违纪"是违法条款。',
            plain_language: '合同说必须无偿加班，不加班就违纪开除，这违反劳动法，加班要给双倍或三倍工资。',
            severity: '高',
        },
        {
            keywords: ['扣除押金', '扣押工资', '风险抵押', '入职押金'],
            title: '违法扣押押金/工资条款',
            legal_reference: '《中华人民共和国劳动合同法》第九条（不得扣押证件财物）、第八十四条（罚款法律责任）',
            dispute_rationale: '用人单位不得扣押劳动者证件或收取押金，不得以任何名义扣留工资作为"风险抵押"。',
            plain_language: '公司扣你押金或者扣部分工资当"押金"，这是违法的，离职时必须全额退还。',
            severity: '高',
        },
        {
            keywords: ['甲方保留随时', '甲方有权随时', '随时调整', '随时变更'],
            title: '用人单位单方随意变更权',
            legal_reference: '《中华人民共和国劳动合同法》第三十五条（变更须协商一致）；《民法典》第五百四十三条（合同变更）',
            dispute_rationale: '劳动合同的变更须双方协商一致，用人单位不得以"甲方保留权利"为由单方变更合同核心条款。',
            plain_language: '合同说公司可以"随时调整"你的岗位、工资、工作地点，但这些必须双方同意，不能公司单方说了算。',
            severity: '高',
        },
    ];

    for (const pattern of riskPatterns) {
        // 检查合同原文是否包含该风险关键词
        const matched = pattern.keywords.some(kw => plainText.includes(kw));
        if (!matched) continue;

        // 提取包含关键词的那句话作为 original_clause
        let clauseText = '';
        for (const kw of pattern.keywords) {
            const idx = plainText.indexOf(kw);
            if (idx >= 0) {
                // 取关键词前后各60字符作为上下文
                const start = Math.max(0, idx - 60);
                const end = Math.min(plainText.length, idx + kw.length + 60);
                clauseText = plainText.slice(start, end).replace(/\s+/g, ' ').trim();
                break;
            }
        }
        if (!clauseText) continue;

        // 如果已有的 dispute_points 中没有相近的原文，则补充
        const clauseKey = clauseText.replace(/\s+/g, '').slice(0, 30);
        const alreadyHas = existingClauses.has(clauseKey) ||
            points.some(p => (p.original_clause || '').includes(pattern.keywords[0]));
        if (alreadyHas) continue;

        existingClauses.add(clauseKey);
        points.push({
            title: pattern.title,
            original_clause: clauseText,
            legal_reference: pattern.legal_reference,
            dispute_rationale: pattern.dispute_rationale,
            plain_language: pattern.plain_language,
            severity: pattern.severity,
        });
    }

    analysisResult.dispute_points = points;
};

const normalizeAnalysisResult = (result) => {
    const raw = result || {};
    const highCount = Array.isArray(raw.dispute_points)
        ? raw.dispute_points.filter(p => String(p.severity || '').includes('高') || String(p.severity || '').includes('high')).length
        : 0;
    const medCount = Array.isArray(raw.dispute_points)
        ? raw.dispute_points.filter(p => String(p.severity || '').includes('中') || String(p.severity || '').includes('medium')).length
        : 0;
    const totalCount = Array.isArray(raw.dispute_points) ? raw.dispute_points.length : 0;

    let overall_risk_level = typeof raw.overall_risk_level === 'string' ? raw.overall_risk_level.trim() : '';
    if (!overall_risk_level || !['高','中','低','high','medium','low'].includes(overall_risk_level)) {
        if (highCount >= 3) overall_risk_level = '高';
        else if (highCount >= 1) overall_risk_level = '中';
        else if (medCount >= 1) overall_risk_level = '中';
        else overall_risk_level = '低';
    }

    let overall_summary = typeof raw.overall_summary === 'string' ? raw.overall_summary.trim() : '';
    if (!overall_summary && totalCount > 0) {
        const levelMap = { '高': '高风险', '中': '中等风险', '低': '低风险', 'high': '高风险', 'medium': '中等风险', 'low': '低风险' };
        const levelLabel = levelMap[overall_risk_level] || '风险';
        overall_summary = `本合同经 AI 深度审查，共识别出 ${totalCount} 项需关注条款，其中高风险 ${highCount} 项、中风险 ${medCount} 项。整体评定为${levelLabel}合同，建议优先处理高风险条款，重点关注试用期工资、合同解除权、竞业限制等核心权益条款。`;
    }

    return {
        overall_summary,
        overall_risk_level,
        dispute_points: Array.isArray(raw.dispute_points) ? raw.dispute_points : [],
        missing_clauses: Array.isArray(raw.missing_clauses) ? raw.missing_clauses : [],
        party_review: Array.isArray(raw.party_review) ? raw.party_review : [],
        modification_suggestions: Array.isArray(raw.modification_suggestions) ? raw.modification_suggestions : [],
        breach_cost_analysis: Array.isArray(raw.breach_cost_analysis) ? raw.breach_cost_analysis : [],
        seal_analysis: Array.isArray(raw.seal_analysis) ? raw.seal_analysis : [],
        relevant_laws: Array.isArray(raw.relevant_laws) ? raw.relevant_laws : [],
        company_review: Array.isArray(raw.company_review) ? raw.company_review : [],
    };
};

// 将合同正文按章节拆分为若干组（每组 500-1200 字，约 3-5 个条款）
const splitContractIntoSections = (plainText) => {
    if (!plainText || typeof plainText !== 'string') return [];
    const text = plainText.trim();
    if (text.length < 200) return [{ index: 0, title: '全文', content: text }];

    // 优先按"第X条"拆分（劳动合同/民事合同标准格式）
    const clausePattern = /((?:^|\n)[ \t]*(?:第[一二三四五六七八九十百零\d]+[条章节款])|(?:^|\n)[ \t]*(?:一\s*[、.。]|二\s*[、.。]|三\s*[、.。]|四\s*[、.。]|五\s*[、.。]|六\s*[、.。]|七\s*[、.。]|八\s*[、.。]))/gm;
    const matches = [{ offset: 0 }, ...Array.from(text.matchAll(clausePattern)).map(m => ({ offset: m.index, text: m[1] }))];

    const sections = [];
    for (let i = 0; i < matches.length; i++) {
        const start = matches[i].offset;
        const end = i + 1 < matches.length ? matches[i + 1].offset : text.length;
        const content = text.slice(start, end).trim();
        const sectionTitle = matches[i].text ? matches[i].text.replace(/[\n\r\s]+/g, ' ').trim() : `第${i + 1}段`;
        if (content.length >= 50) { // 过滤过短的段
            sections.push({ index: sections.length, title: sectionTitle, content });
        }
    }

    // 如果拆分结果过少（<3段），改为固定字数重叠拆分
    if (sections.length < 3) {
        const chunkSize = 800;
        const overlap = 100;
        const newSections = [];
        for (let i = 0; i < text.length; i += chunkSize - overlap) {
            const content = text.slice(i, Math.min(i + chunkSize, text.length)).trim();
            if (content.length >= 100) {
                newSections.push({ index: newSections.length, title: `第${newSections.length + 1}部分`, content });
            }
            if (i + chunkSize >= text.length) break;
        }
        return newSections;
    }

    // 将相邻的小段合并为 batch（每 batch 约 1000-1500 字）
    const batches = [];
    let currentBatch = { sections: [], combinedContent: '', startIdx: 0 };
    let currentSize = 0;
    const TARGET_SIZE = 1200;

    for (const section of sections) {
        if (currentSize + section.content.length > TARGET_SIZE && currentSize > 0) {
            batches.push(currentBatch);
            currentBatch = { sections: [], combinedContent: '', startIdx: batches.length };
            currentSize = 0;
        }
        currentBatch.sections.push(section);
        currentBatch.combinedContent += (currentBatch.combinedContent ? '\n' : '') + section.content;
        currentSize += section.content.length;
    }
    if (currentBatch.sections.length > 0) batches.push(currentBatch);

    return batches;
};

// 逐组并行审查：每个 batch 并行调用 LLM，聚合所有 dispute_points
const batchReviewSections = async (batches, template, userPerspective, relevantKnowledge, reviewPoints, corePurposes, callJsonLLMFn) => {
    const knowledgeContext = relevantKnowledge.length > 0
        ? relevantKnowledge.map((item, idx) => `[${idx + 1}] [${item.source_type}] ${item.law} ${item.clause || ''}：${item.content}`).join('\n')
        : '未检索到直接依据。';

    const buildBatchPrompt = (batchContent, batchIdx, totalBatches) => `你是资深法务专家，请对以下合同章节（第 ${batchIdx + 1}/${totalBatches} 组）进行深度专项审查，并只输出 JSON。

审查模板：${template.name}
合同类型：${template.name}
用户立场：${userPerspective}
审查点：${reviewPoints.join('；')}
审查目的：${corePurposes.join('；')}
模板规则：${(template.prompt_rules || []).join('；')}

法律依据（仅引用以下内容，不得虚构）：
${knowledgeContext}

待审查章节内容：
---
${batchContent.slice(0, 3000)}
---

硬性要求：
- 必须识别所有类型的风险（违法条款/霸王条款/不公平条款/缺失条款/程序性违规），即使是常见条款也不能跳过。
- 重点关注：单方解释权、无偿解除、强制加班、限制生育、押金扣押、单方变更权等典型霸王条款。
- 如果该章节无任何风险，请在 dispute_points 中返回一个空数组 []。
- modification_suggestions 必须包含 original_text（尽量逐字摘录原文完整句子）和 suggested_text（可直接替换的完整文本）。
- 只输出 JSON，不输出 markdown 包裹。

输出 JSON 结构：
{
  "dispute_points": [{"title":"风险标题","original_clause":"合同原文","legal_reference":"依据","dispute_rationale":"风险说明","plain_language":"大白话说明","severity":"高/中/低"}],
  "missing_clauses": [{"title":"缺失条款","description":"为什么缺失","suggested_clause":"可补充条款"}],
  "modification_suggestions": [{"title":"建议标题","original_text":"合同中可定位的完整原文句子或段落","suggested_text":"可直接替换 original_text 的完整文本","reason":"修改理由","plain_language":"大白话说明","anchor_hint":"用于定位的短语"}]
}`;

    const totalBatches = batches.length;
    const prompts = batches.map((batch, idx) => buildBatchPrompt(batch.combinedContent, idx, totalBatches));

    // 并行调用 LLM（所有 batch 同时请求）
    const batchResults = await Promise.all(prompts.map(p => callJsonLLMFn(p)));

    // 聚合所有结果
    const allDisputePoints = [];
    const allMissingClauses = [];
    const allModificationSuggestions = [];
    const seenClauseKeys = new Set();

    const addIfNotDuplicate = (arr, item, keyField) => {
        if (!item || typeof item !== 'object') return;
        const key = (item[keyField] || '').replace(/\s+/g, '').slice(0, 30);
        if (!key || seenClauseKeys.has(key)) return;
        // 去重：检查 title + original_clause 组合
        const dupKey = `${item.title || ''}_${key}`;
        if (seenClauseKeys.has(dupKey)) return;
        seenClauseKeys.add(dupKey);
        seenClauseKeys.add(key);
        arr.push(item);
    };

    for (const result of batchResults) {
        if (!result) continue;
        if (Array.isArray(result.dispute_points)) {
            result.dispute_points.forEach(p => addIfNotDuplicate(allDisputePoints, p, 'original_clause'));
        }
        if (Array.isArray(result.missing_clauses)) {
            result.missing_clauses.forEach(c => {
                if (c && typeof c === 'object') allMissingClauses.push(c);
            });
        }
        if (Array.isArray(result.modification_suggestions)) {
            result.modification_suggestions.forEach(s => addIfNotDuplicate(allModificationSuggestions, s, 'original_text'));
        }
    }

    return {
        dispute_points: allDisputePoints,
        missing_clauses: allMissingClauses,
        modification_suggestions: allModificationSuggestions,
        batch_count: totalBatches,
    };
};
