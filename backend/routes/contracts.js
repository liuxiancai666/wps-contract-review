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
const { buildWpsEditorConfig } = require('../services/wpsEditor');

// 合同正文段落 chunk 检索上限：0 = 不限；超过部分不再生成子 query，控制长合同的检索成本
const CONTRACT_CHUNK_MAX = Math.max(0, Number(process.env.CONTRACT_CHUNK_MAX || 30));

const router = express.Router();

const WPS_TOKEN_SECRET = process.env.WPS_TOKEN_SECRET || process.env.ONLYOFFICE_JWT_SECRET || '';
const APP_HOST = process.env.APP_HOST;
const BACKEND_URL_FOR_DOCKER = process.env.BACKEND_URL_FOR_DOCKER || APP_HOST;

const ALLOWED_EXTENSIONS = ['.docx', '.doc', '.pdf'];
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
    if (ext === '.doc') {
        // 使用 antiword 提取 .doc 文档文本
        return new Promise((resolve, reject) => {
            const { exec } = require('child_process');
            exec(`antiword "${filePath}"`, { timeout: 30000 }, (error, stdout, stderr) => {
                if (error) {
                    // antiword 失败时尝试 catdoc 作为备用
                    exec(`catdoc "${filePath}"`, { timeout: 30000 }, (err2, out2) => {
                        if (err2 || !out2?.trim()) {
                            reject(new Error('无法提取 .doc 文档文本，文件可能已损坏或为旧版格式。'));
                        } else {
                            resolve(out2);
                        }
                    });
                } else if (!stdout || !stdout.trim()) {
                    reject(new Error('.doc 文档文本提取为空。'));
                } else {
                    resolve(stdout);
                }
            });
        });
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
    { key: 'batch_annotations', label: '写入审查批注', weight: 0, estSeconds: 2 },
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
    const { percent: stepPercent, stepIndex, totalSteps } = getStepProgress(stepKey, status);

    // 如果 payload 中有自定义 percent，使用它（用于 llm_review 的逐批进度更新）
    // 否则使用 stepPercent（基于步骤权重的固定估算）
    const effectivePercent = typeof payload.percent === 'number' ? payload.percent : stepPercent;

    const event = {
        contractId: Number(contractId),
        timestamp: new Date().toISOString(),
        stepIndex,
        totalSteps,
        stepLabel: ANALYSIS_STEPS.find((s) => s.key === stepKey)?.label || stepKey,
        elapsedSeconds: 0,
        ...payload,
        // 确保 percent 始终使用 effectivePercent（payload 中的 percent 会被下面覆盖）
        percent: effectivePercent,
    };

    // 基于已耗时动态估算 ETA（替代固定 TOTAL_EST_SECONDS 计算的偏差值）
    const emitJob = analysisJobs.get(Number(contractId));

    // 更新内存任务状态 — 永不回退（防止 batch 进度回调与首次 emit 的时间差导致 65%→35%）
    if (emitJob) {
        if (event.percent > emitJob.percent || emitJob.percent === 0) emitJob.percent = event.percent;
        emitJob.currentStep = stepKey;
        emitJob.status = status === 'failed' ? 'failed' : (event.percent >= 100 ? 'completed' : 'running');
        emitJob.elapsedSeconds = Math.round((Date.now() - emitJob.startedAt) / 1000);
        event.elapsedSeconds = emitJob.elapsedSeconds;
        const stepEntry = emitJob.steps.find((s) => s.key === stepKey);
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

// buildWpsEditorConfig is imported from ../services/wpsEditor

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

// 知识库检索缓存（TTL 600s 避免相同合同类型重复检索）
const knowledgeCache = new Map();
const KNOWLEDGE_CACHE_TTL = Number(process.env.KNOWLEDGE_CACHE_TTL || 600000); // 10min

const getCacheKey = (options) => {
  if (typeof options === 'string') return `s:${options.slice(0, 100)}`;
  const { text, contractType, reviewPoints, corePurposes, perspective, question, templateId } = options;
  return `o:${contractType}|${(reviewPoints||[]).sort().join(',')}|${(corePurposes||[]).sort().join(',')}|${perspective||''}|${question||''}|${templateId||''}`;
};

// 知识库检索：分通道召回 + 配额融合
//   通道 A「审查维度」法律语言，主力，占 2/3 配额，每条 query 召回 3 条
//   通道 B「合同内容」捞审查点未覆盖的非常规条款，补充，占 1/3 配额，每条 query 仅 top-1 且强阈值
// CONTRACT_CHUNK_MAX > 0 时限制通道 B 的 chunk 数，控制长合同检索成本
const getRelevantKnowledge = async (options, limit = 8) => {
    // 缓存命中检查
    const cacheKey = getCacheKey(options);
    const cached = knowledgeCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < KNOWLEDGE_CACHE_TTL) {
      console.log(`[Knowledge Cache] HIT for key ${cacheKey.slice(0, 60)}...`);
      return cached.data;
    }

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
    
    const result = mergeChannelsWithConfidence(channelA, channelB, limit).map(toRelevantKnowledgeItem);
    // 写入缓存
    knowledgeCache.set(cacheKey, { data: result, timestamp: Date.now() });
    return result;
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
    const existingClauses = new Set(points.map(p => (p.original_clause || '').replace(/\s+/g, '').slice(0, 30)));
    const riskPatterns = [
        { keywords: ['解释权归', '解释权归甲方', '解释权归公司', '最终解释权'], title: '单方解释权条款（霸王条款）', legal_reference: '《民法典》第六条（公平原则）、第七条（诚信原则）；《中华人民共和国劳动合同法》第三条（公平原则）', dispute_rationale: '"单方解释权"赋予用人单位对合同条款的最终解释权，劳动者无法对条款含义提出异议，违反合同公平原则，属于典型格式霸王条款。', plain_language: '这条款说"最终解释权归公司"，意味着公司可以随便解读合同内容，劳动者说了不算，这是不公平的。', severity: '高' },
        { keywords: ['无偿解除', '无偿解除合同', '无偿辞退', '不支付任何补偿解除'], title: '无偿违法解除条款', legal_reference: '《中华人民共和国劳动合同法》第四十六条（经济补偿）、第四十八条（违法解除赔偿）', dispute_rationale: '用人单位违法解除或终止劳动合同须支付赔偿金，约定"无偿解除"违反法律规定，该条款无效。', plain_language: '合同写公司可以"无偿开除"你，但法律不允许这样做，被违法开除可以要求2N赔偿金。', severity: '高' },
        { keywords: ['限制结婚', '限制生育', '不得结婚', '不得生育'], title: '限制结婚生育条款（违法）', legal_reference: '《中华人民共和国劳动合同法》第三条；《就业促进法》第二十七条；《妇女权益保障法》第四十四条', dispute_rationale: '用人单位不得规定女职工在孕产哺乳期解除劳动合同，或限制其结婚生育，此类条款违法且无效。', plain_language: '合同规定不能结婚生孩子，这是违法的，公司不能用这个理由开除你。', severity: '高' },
        { keywords: ['加班必须', '强制加班', '拒绝加班视为', '不服从加班'], title: '强制加班且拒绝即违纪', legal_reference: '《中华人民共和国劳动法》第四十一条（加班上限）、第四十三条（支付加班费）', dispute_rationale: '用人单位不得强制加班，员工有权拒绝超时加班。将拒绝加班列为"严重违纪"是违法条款。', plain_language: '合同说必须无偿加班，不加班就违纪开除，这违反劳动法，加班要给双倍或三倍工资。', severity: '高' },
        { keywords: ['扣除押金', '扣押工资', '风险抵押', '入职押金'], title: '违法扣押押金/工资条款', legal_reference: '《中华人民共和国劳动合同法》第九条（不得扣押证件财物）、第八十四条（罚款法律责任）', dispute_rationale: '用人单位不得扣押劳动者证件或收取押金，不得以任何名义扣留工资作为"风险抵押"。', plain_language: '公司扣你押金或者扣部分工资当"押金"，这是违法的，离职时必须全额退还。', severity: '高' },
        { keywords: ['甲方保留随时', '甲方有权随时', '随时调整', '随时变更'], title: '用人单位单方随意变更权', legal_reference: '《中华人民共和国劳动合同法》第三十五条（变更须协商一致）；《民法典》第五百四十三条（合同变更）', dispute_rationale: '劳动合同的变更须双方协商一致，用人单位不得以"甲方保留权利"为由单方变更合同核心条款。', plain_language: '合同说公司可以"随时调整"你的岗位、工资、工作地点，但这些必须双方同意，不能公司单方说了算。', severity: '高' },
    ];
    for (const pattern of riskPatterns) {
        const matched = pattern.keywords.some(kw => plainText.includes(kw));
        if (!matched) continue;
        let clauseText = '';
        for (const kw of pattern.keywords) {
            const idx = plainText.indexOf(kw);
            if (idx >= 0) { clauseText = plainText.slice(Math.max(0, idx - 60), Math.min(plainText.length, idx + kw.length + 60)).replace(/\s+/g, ' ').trim(); break; }
        }
        if (!clauseText) continue;
        if (existingClauses.has(clauseText.replace(/\s+/g, '').slice(0, 30)) || points.some(p => (p.original_clause || '').includes(pattern.keywords[0]))) continue;
        existingClauses.add(clauseText.replace(/\s+/g, '').slice(0, 30));
        points.push({ title: pattern.title, original_clause: clauseText, legal_reference: pattern.legal_reference, dispute_rationale: pattern.dispute_rationale, plain_language: pattern.plain_language, severity: pattern.severity });
    }
    analysisResult.dispute_points = points;
};

const normalizeAnalysisResult = (result) => {
    const raw = result || {};
    const highCount = Array.isArray(raw.dispute_points) ? raw.dispute_points.filter(p => String(p.severity || '').includes('高') || String(p.severity || '').includes('high')).length : 0;
    const medCount = Array.isArray(raw.dispute_points) ? raw.dispute_points.filter(p => String(p.severity || '').includes('中') || String(p.severity || '').includes('medium')).length : 0;
    const totalCount = Array.isArray(raw.dispute_points) ? raw.dispute_points.length : 0;
    let overall_risk_level = typeof raw.overall_risk_level === 'string' ? raw.overall_risk_level.trim() : '';
    if (!overall_risk_level || !['高','中','低','high','medium','low'].includes(overall_risk_level)) {
        if (highCount >= 3) overall_risk_level = '高'; else if (highCount >= 1) overall_risk_level = '中'; else if (medCount >= 1) overall_risk_level = '中'; else overall_risk_level = '低';
    }
    let overall_summary = typeof raw.overall_summary === 'string' ? raw.overall_summary.trim() : '';
    if (!overall_summary && totalCount > 0) {
        const levelMap = { '高': '高风险', '中': '中等风险', '低': '低风险', 'high': '高风险', 'medium': '中等风险', 'low': '低风险' };
        const levelLabel = levelMap[overall_risk_level] || '风险';
        overall_summary = `本合同经 AI 深度审查，共识别出 ${totalCount} 项需关注条款，其中高风险 ${highCount} 项、中风险 ${medCount} 项。整体评定为${levelLabel}合同，建议优先处理高风险条款，重点关注试用期工资、合同解除权、竞业限制等核心权益条款。`;
    }
    return { overall_summary, overall_risk_level, dispute_points: Array.isArray(raw.dispute_points) ? raw.dispute_points : [], missing_clauses: Array.isArray(raw.missing_clauses) ? raw.missing_clauses : [], party_review: Array.isArray(raw.party_review) ? raw.party_review : [], modification_suggestions: Array.isArray(raw.modification_suggestions) ? raw.modification_suggestions : [], breach_cost_analysis: Array.isArray(raw.breach_cost_analysis) ? raw.breach_cost_analysis : [], seal_analysis: Array.isArray(raw.seal_analysis) ? raw.seal_analysis : [], relevant_laws: Array.isArray(raw.relevant_laws) ? raw.relevant_laws : [], company_review: Array.isArray(raw.company_review) ? raw.company_review : [] };
};

router.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).send('No file uploaded.');
    const { userId, groupId } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID is required for upload.' });

    try {
        const contractRecord = await db.transaction(async (trx) => {
            const safeUserId = await ensureUploadUser(trx, userId);
            const originalFilenameDecoded = iconv.decode(Buffer.from(req.file.originalname, 'binary'), 'utf-8');
            const documentKey = uuidv4();

            // .doc → .docx 转换：WPS WebOffice 不支持 .doc 格式
            let storagePath = req.file.path;
            const fileExt = path.extname(originalFilenameDecoded).toLowerCase();
            if (fileExt === '.doc' || fileExt === '.wps') {
                const docxPath = storagePath.replace(/\.\w+$/, '') + '.docx';
                try {
                    const text = await extractTextFromFile(storagePath);
                    // 使用 docx 包生成完整 OOXML，确保 WPS 可正常渲染
                    const { Document, Packer, Paragraph, TextRun } = require('docx');
                    const lines = text.split('\n');
                    const paragraphs = lines.map(line => {
                        const trimmed = line.trim();
                        if (!trimmed) return new Paragraph({ spacing: { after: 120 } });
                        return new Paragraph({
                            spacing: { after: 80, line: 360 },
                            children: [new TextRun({ text: trimmed, font: '宋体', size: 24 })],
                        });
                    });
                    const doc = new Document({
                        styles: {
                            default: {
                                document: {
                                    run: { font: '宋体', size: 24 },
                                    paragraph: { spacing: { line: 360 } },
                                },
                            },
                        },
                        sections: [{ children: paragraphs }],
                    });
                    const buffer = await Packer.toBuffer(doc);
                    fs.writeFileSync(docxPath, buffer);
                    // 删除原始 .doc 文件
                    try { fs.unlinkSync(storagePath); } catch {}
                    storagePath = docxPath;
                    console.log(`[UPLOAD] Converted .doc to proper DOCX: ${docxPath} (${buffer.length} bytes)`);
                } catch (convErr) {
                    console.warn('[UPLOAD] .doc conversion failed, falling back to original:', convErr.message);
                }
            }
            const [newContract] = await trx('contracts').insert({
                user_id: safeUserId,
                original_filename: originalFilenameDecoded,
                storage_path: storagePath,
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
            original_filename: contractRecord.original_filename,
            editorConfig: buildWpsEditorConfig(contractRecord, ext),
        });
    } catch (error) {
        if (error.message === 'INVALID_USER_ID') {
            return res.status(400).json({ error: 'Invalid user ID for upload.' });
        }
        console.error('[ERROR] Error processing upload for WPS WebOffice:', error);
        res.status(500).json({ error: 'Server error during file upload.' });
    }
});

// WPS WebOffice v3 协议通过回调自动处理保存，此端点为前端备用
router.post('/save-callback', async (req, res) => {
    try {
        const body = req.body;
        console.log('[WPS WebOffice] save callback:', {
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
                console.log(`[WPS] saved file for contract ${contract.id} from status ${body.status}`);
            } else {
                console.warn('[WPS] save callback skipped: contract or download url missing');
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

// 将合同正文按章节拆分为若干组（每组 500-1200 字，约 3-5 个条款）
const splitContractIntoSections = (plainText) => {
    if (!plainText || typeof plainText !== 'string') return [];
    const text = plainText.trim();
    if (text.length < 200) return [{ index: 0, title: '全文', content: text, combinedContent: text }];
    const clausePattern = /((?:^|\n)[ \t]*(?:第[一二三四五六七八九十百零\d]+[条章节款])|(?:^|\n)[ \t]*(?:一\s*[、.。]|二\s*[、.。]|三\s*[、.。]|四\s*[、.。]|五\s*[、.。]|六\s*[、.。]|七\s*[、.。]|八\s*[、.。]))/gm;
    const matches = [{ offset: 0 }, ...Array.from(text.matchAll(clausePattern)).map(m => ({ offset: m.index, text: m[1] }))];
    const sections = [];
    for (let i = 0; i < matches.length; i++) {
        const start = matches[i].offset;
        const end = i + 1 < matches.length ? matches[i + 1].offset : text.length;
        const content = text.slice(start, end).trim();
        const sectionTitle = matches[i].text ? matches[i].text.replace(/[\n\r\s]+/g, ' ').trim() : `第${i + 1}段`;
        if (content.length >= 50) sections.push({ index: sections.length, title: sectionTitle, content });
    }
    if (sections.length < 3) {
        const chunkSize = 800, overlap = 100, batches = [];
        for (let i = 0; i < text.length; i += chunkSize - overlap) {
            const content = text.slice(i, Math.min(i + chunkSize, text.length)).trim();
            if (content.length >= 100) batches.push({ index: batches.length, title: `第${batches.length + 1}部分`, content, combinedContent: content });
            if (i + chunkSize >= text.length) break;
        }
        return batches;
    }
    const batches = [];
    let currentBatch = { sections: [], combinedContent: '', titles: [], startIdx: 0 };
    let currentSize = 0;
    const TARGET_SIZE = 1200;
    for (const section of sections) {
        if (currentSize + section.content.length > TARGET_SIZE && currentSize > 0) { batches.push(currentBatch); currentBatch = { sections: [], combinedContent: '', titles: [], startIdx: batches.length }; currentSize = 0; }
        currentBatch.sections.push(section);
        currentBatch.titles.push(section.title);
        currentBatch.combinedContent += (currentBatch.combinedContent ? '\n' : '') + section.content;
        currentSize += section.content.length;
    }
    if (currentBatch.sections.length > 0) batches.push(currentBatch);
    return batches;
};

// 并发控制：限制同时进行的 LLM 调用数，避免 API 限流
const LLM_CONCURRENCY = Math.max(1, Number(process.env.LLM_CONCURRENCY || 3));
const parallelLimit = async (tasks, limit = LLM_CONCURRENCY) => {
  const results = [];
  const executing = new Set();
  for (const [i, task] of tasks.entries()) {
    const p = task().then(r => { results[i] = r; executing.delete(p); }, e => { results[i] = Promise.reject(e); executing.delete(p); });
    executing.add(p);
    if (executing.size >= limit) await Promise.race(executing);
  }
  await Promise.all(executing);
  return results;
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
    const prompts = batches.map((batch, idx) => {
      const content = String(batch.content || batch.combinedContent || '');
      const titleContext = batch.titles?.length ? `所属章节：${batch.titles.join('、')}\n\n` : '';
      return buildBatchPrompt(content.length >= 50 ? titleContext + content : content, idx, totalBatches);
    });
    const batchResults = await parallelLimit(prompts.map(p => () => callJsonLLMFn(p)));
    const allDisputePoints = [], allMissingClauses = [], allModificationSuggestions = [];
    const seenClauseKeys = new Set();
    const addIfNotDuplicate = (arr, item, keyField) => {
        if (!item || typeof item !== 'object') return;
        const key = (item[keyField] || '').replace(/\s+/g, '').slice(0, 30);
        if (!key || seenClauseKeys.has(key)) return;
        const dupKey = `${item.title || ''}_${key}`;
        if (seenClauseKeys.has(dupKey)) return;
        seenClauseKeys.add(dupKey); seenClauseKeys.add(key); arr.push(item);
    };
    for (const result of batchResults) {
        if (!result) continue;
        if (Array.isArray(result.dispute_points)) result.dispute_points.forEach(p => addIfNotDuplicate(allDisputePoints, p, 'original_clause'));
        if (Array.isArray(result.missing_clauses)) result.missing_clauses.forEach(c => { if (c && typeof c === 'object') allMissingClauses.push(c); });
        if (Array.isArray(result.modification_suggestions)) result.modification_suggestions.forEach(s => addIfNotDuplicate(allModificationSuggestions, s, 'original_text'));
    }
    return { dispute_points: allDisputePoints, missing_clauses: allMissingClauses, modification_suggestions: allModificationSuggestions, batch_count: totalBatches };
};

// 带进度回调的分组审查 — 顺序执行每个 batch，每完成一个就回调进度
// 解决 llm_review 阶段长时间无进度推送导致前端 socket 超时回退问题
const batchReviewSectionsWithProgress = async (batches, template, userPerspective, relevantKnowledge, reviewPoints, corePurposes, callJsonLLMFn, onProgress) => {
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
    const allDisputePoints = [], allMissingClauses = [], allModificationSuggestions = [];
    const seenClauseKeys = new Set();
    const addIfNotDuplicate = (arr, item, keyField) => {
        if (!item || typeof item !== 'object') return;
        const key = (item[keyField] || '').replace(/\s+/g, '').slice(0, 30);
        if (!key || seenClauseKeys.has(key)) return;
        const dupKey = `${item.title || ''}_${key}`;
        if (seenClauseKeys.has(dupKey)) return;
        seenClauseKeys.add(dupKey); seenClauseKeys.add(key); arr.push(item);
    };

    // 顺序执行每个 batch，每完成一个回调进度（推送 socket 保持连接活跃）
    for (let idx = 0; idx < batches.length; idx++) {
        const batch = batches[idx];
        let content = String(batch.content || batch.combinedContent || '');
        const titleContext = batch.titles?.length ? `所属章节：${batch.titles.join('、')}\n\n` : '';
        const prompt = buildBatchPrompt(content.length >= 50 ? titleContext + content : content, idx, totalBatches);
        try {
            const result = await callJsonLLMFn(prompt);
            if (result) {
                if (Array.isArray(result.dispute_points)) result.dispute_points.forEach(p => addIfNotDuplicate(allDisputePoints, p, 'original_clause'));
                if (Array.isArray(result.missing_clauses)) result.missing_clauses.forEach(c => { if (c && typeof c === 'object') allMissingClauses.push(c); });
                if (Array.isArray(result.modification_suggestions)) result.modification_suggestions.forEach(s => addIfNotDuplicate(allModificationSuggestions, s, 'original_text'));
            }
        } catch (e) {
            console.warn(`[Progress Review] Batch ${idx + 1}/${totalBatches} failed:`, e.message);
        }
        // 每完成一个 batch 回调进度，保持 socket 活跃
        if (typeof onProgress === 'function') {
            try { onProgress(idx + 1, totalBatches); } catch {}
        }
    }
    return { dispute_points: allDisputePoints, missing_clauses: allMissingClauses, modification_suggestions: allModificationSuggestions, batch_count: totalBatches };
};

// 轻量内存任务队列：大合同分析不阻塞主事件循环
class AnalysisTaskQueue {
  constructor(concurrency = 2) {
    this.concurrency = concurrency;
    this.queue = [];
    this.running = 0;
  }
  enqueue(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.processNext();
    });
  }
  processNext() {
    if (this.running >= this.concurrency || this.queue.length === 0) return;
    this.running++;
    const { task, resolve, reject } = this.queue.shift();
    Promise.resolve().then(() => task())
      .then(resolve, reject)
      .finally(() => {
        this.running--;
        this.processNext();
      });
  }
}
const analysisTaskQueue = new AnalysisTaskQueue(2);

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

        // Step 2: 检索法条与案例依据
        await emitAnalysisProgress(null, contractId, { step: 'knowledge_search', status: 'running', message: '正在检索法条与案例依据...' });
        // 分析整个合同，法律条文适当增加检索范围，如果后续需要，再增加检索数量 30 -> n
        const relevantKnowledge = await getRelevantKnowledge({
            text: plainText,
            contractType: preAnalysisData.contract_type,
            reviewPoints,
            corePurposes,
            perspective: userPerspective,
        }, 40);
        await emitAnalysisProgress(null, contractId, { step: 'knowledge_search', status: 'completed', message: `法条与案例依据检索已完成（${relevantKnowledge.length} 条）。`, partialResult: { relevant_laws: annotateKnowledgeUpdates(relevantKnowledge) } });

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

        // Step 4: AI 逐组并行审查（替代一次性全篇审查，解决上下文过载导致的漏检问题）
        // 首次 emit 用 40%（前3步累计权重），与后续 batch 回调起点一致，防止进度回退（65%→40%）
        await emitAnalysisProgress(null, contractId, { step: 'llm_review', status: 'running', percent: 40, message: 'AI 正在分章节深度审查合同，请耐心等待...' });

        // 按章节/条款拆分合同正文为若干 batch，并行审查每个 batch
        const batches = splitContractIntoSections(plainText);
        const reviewResults = await batchReviewSectionsWithProgress(
            batches, template, userPerspective, relevantKnowledge,
            reviewPoints, corePurposes, callJsonLLM,
            // 每完成一组 batch 推送一次进度，防止 socket 超时导致前端子%回退
            (completed, total) => {
                const pct = Math.round((completed / total) * 100);
                // 百分比映射到 llm_review 阶段（权重50%），范围=前3步累积(40%)~前3步+llm(90%)
                const overallPct = 40 + Math.round(pct * 0.5);
                emitAnalysisProgress(null, contractId, {
                    step: 'llm_review', status: 'running',
                    message: `AI 正在分章节深度审查合同（已完成 ${completed}/${total} 组）...`,
                    percent: overallPct,
                }).catch(() => {});
            }
        );

        // 构造 analysisResult（合并 batch 结果 + 公司主体审查 + 整体摘要）
        const analysisResult = {
            ...normalizeAnalysisResult({ dispute_points: reviewResults.dispute_points }),
            missing_clauses: reviewResults.missing_clauses || [],
            modification_suggestions: reviewResults.modification_suggestions || [],
            breach_cost_analysis: [],
        };

        // 兜底检测：补充 LLM 可能遗漏的典型霸王条款
        supplementKnownRiskPatterns(analysisResult, plainText);

        // 公司主体审查（来自 Step 3 的外部搜索结果，不依赖 LLM）
        analysisResult.company_review = companySearchResults.map((company) => ({
            company_name: company.companyName,
            status: company.verifiedResults.length ? '已检索到可初步核验的主体线索' : '未检索到足够可靠的主体证据',
            evidence_summary: company.verifiedResults[0]?.snippet || company.results[0]?.snippet || '外部搜索未返回足够证据。',
            authenticity: company.verifiedResults.length
                ? '存在官方或多源交叉线索，仍需以国家企业信用信息公示系统等正式渠道为准。'
                : '搜索结果未通过基础真实性检测，不能据此下结论。',
            sources: (company.verifiedResults.length ? company.verifiedResults : company.results).slice(0, 3).map((item) => item.url),
        }));

        analysisResult.relevant_laws = annotateKnowledgeUpdates(relevantKnowledge);
        analysisResult.company_search = companySearchResults;
        analysisResult.template = {
            id: template.id,
            name: template.name,
            report_sections: template.report_sections || [],
        };
        await emitAnalysisProgress(null, contractId, { step: 'llm_review', status: 'completed', message: 'AI 审查结论已生成。' });

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

        // Step 7: 将识别出的所有风险以批注形式写入 DOCX 文件（不改变 finalize 状态以避免进度回退）
        const suggestions = analysisResult.modification_suggestions || [];
        const riskPoints = analysisResult.dispute_points || [];
        const missingClauses = analysisResult.missing_clauses || [];
        let newEditorConfig = null;
        const allAnnotations = [];
        for (const s of suggestions) {
            allAnnotations.push({
                original_text: s.original_text,
                body: `【AI审查—修改建议】${s.title || '修改建议'}\n建议：${s.suggested_text || ''}\n理由：${s.reason || ''}`,
            });
        }
        for (const r of riskPoints) {
            allAnnotations.push({
                original_text: r.original_clause || '',
                body: `【AI审查—风险】${r.title || '风险'}\n严重程度：${r.severity || '未标明'}\n说明：${r.dispute_rationale || ''}\n法律依据：${r.legal_reference || ''}\n通俗说法：${r.plain_language || ''}`,
            });
        }
        for (const m of missingClauses) {
            allAnnotations.push({
                original_text: '',
                body: `【AI审查—缺失条款】${m.title || '缺失条款'}\n说明：${m.description || ''}\n建议补充：${m.suggested_clause || ''}`,
            });
        }
        if (allAnnotations.length > 0 && !String(contract.original_filename || '').toLowerCase().endsWith('.pdf') && !String(contract.original_filename || '').toLowerCase().endsWith('.doc')) {
            await emitAnalysisProgress(null, contractId, { step: 'batch_annotations', status: 'running', message: `正在将 ${allAnnotations.length} 条审查结果以批注形式写入合同文件...（修改建议 ${suggestions.length} 条，风险 ${riskPoints.length} 条，缺失条款 ${missingClauses.length} 条）` });
            try {
                const { insertReviewComments } = require('../services/docxAnnotator');
                const count = insertReviewComments(contract.storage_path, allAnnotations);
                if (count > 0) {
                    console.log(`[ANNOTATE] Inserted ${count}/${allAnnotations.length} comments into ${contract.storage_path}`);
                    const newDocKey = uuidv4();
                    await db('contracts').where({ id: contractId }).update({ document_key: newDocKey, edit_enabled: true });
                    const ext = String(contract.original_filename || '').toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx';
                    newEditorConfig = buildWpsEditorConfig({ ...contract, id: contractId, document_key: newDocKey, original_filename: contract.original_filename }, ext, { afterReview: true });
                }
                await emitAnalysisProgress(null, contractId, { step: 'batch_annotations', status: 'completed', message: `审查批注已完成，共 ${count}/${allAnnotations.length} 条。` });
            } catch (annotateError) {
                console.warn('[ANNOTATE] Failed to insert comments:', annotateError.message);
                await emitAnalysisProgress(null, contractId, { step: 'batch_annotations', status: 'failed', message: `批注写入失败：${annotateError.message}` });
            }
        }

        if (ioInstance) ioInstance.to(`contract-${contractId}`).emit('analysis-complete', { results: analysisResult, perspective: userPerspective, newEditorConfig });
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

        // 后台异步执行（通过任务队列，限制并发数，避免大合同阻塞）
        analysisTaskQueue.enqueue(() =>
            runAnalysisInBackground(contractId, userId, userPerspective, preAnalysisData)
        ).catch((err) => {
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
        }, 8);
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

硬性要求：
- 必须逐条比对「可引用依据」中每一条法律条文与待审查文本，特别关注天数、期限、比例、金额、次数等强制性数字是否一致；若存在不一致（例如法定 15 日被写成 30 日），必须在 risk_summary 中明确指出并在 suggested_text 中修正。
- 如果没有检索依据，不得编造法条或案例，只能说明"当前知识库未检索到直接依据"。
- 只输出 JSON，不输出自然语言解释，不输出 markdown。

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
            let parsed = {};
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
            editorConfig: buildWpsEditorConfig(updatedContract, ext),
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
            editorConfig: buildWpsEditorConfig({ ...contract, document_key: nextKey }, ext),
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
            editorConfig: buildWpsEditorConfig({ ...contract, document_key: nextKey }, ext),
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

router.get('/:id/export-annotated-docx', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const contract = await findOwnedContract(req.params.id, userId);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    // WPS 三阶段保存已将批注保存到 storage_path 的 docx 文件中
    // 直接从存储路径返回带批注的最新 docx
    if (!contract.storage_path || !fs.existsSync(contract.storage_path)) {
        return res.status(404).json({ error: 'Contract file not found on disk.' });
    }

    const ext = path.extname(contract.storage_path).toLowerCase();
    if (ext !== '.docx') {
        return res.status(400).json({ error: 'Only DOCX files support annotated export.' });
    }

    const basename = path.basename(contract.original_filename, ext).replace(/[^a-zA-Z0-9._-]/g, '_') || 'contract';
    const filenameAscii = basename + '-annotated.docx';
    const filenameUtf8 = encodeURIComponent(basename + '-批注版.docx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${filenameAscii}"; filename*=UTF-8''${filenameUtf8}`);
    res.sendFile(contract.storage_path);
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

        // WPS WebOffice 通过 v3 回调协议自动保存，前端仅触发标记
        res.json({ ok: true, note: 'WPS WebOffice 自动处理保存，无需手动触发 force-save' });
    } catch (error) {
        console.error(`[ERROR] Failed to force-save contract ${req.params.id}:`, error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to trigger force-save.' });
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
            editorConfig: buildWpsEditorConfig(contractRecord, ext),
        });
    } catch (error) {
        console.error(`[ERROR] Failed to fetch fresh editor config for id ${id}:`, error);
        res.status(500).json({ error: 'Server error while fetching editor config.' });
    }
});

// ============ 批注交互 (review_comments) API ============

// POST /api/contracts/:id/comments — 添加批注/反馈
router.post('/:id/comments', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const contract = await findOwnedContract(req.params.id, userId);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    const { item_type, item_index, action_type, comment_text } = req.body;
    if (!item_type || item_index === undefined || !action_type) {
        return res.status(400).json({ error: 'item_type, item_index, action_type are required.' });
    }
    if (action_type === 'comment' && !comment_text) {
        return res.status(400).json({ error: 'comment_text is required when action_type is comment.' });
    }

    try {
        const [id] = await db('review_comments').insert({
            contract_id: contract.id,
            user_id: Number(userId),
            item_type,
            item_index,
            action_type,
            comment_text: comment_text || null,
            is_resolved: false,
        }).returning('id');
        const row = await db('review_comments').where({ id }).first();
        res.json(row);
    } catch (error) {
        console.error('[ERROR] Failed to add review comment:', error);
        res.status(500).json({ error: 'Failed to add comment.' });
    }
});

// GET /api/contracts/:id/comments — 获取所有批注
router.get('/:id/comments', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const contract = await findOwnedContract(req.params.id, userId);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    try {
        const rows = await db('review_comments')
            .where({ contract_id: contract.id })
            .orderBy('created_at', 'asc')
            .select();
        // 按 item_type + item_index 分组
        const grouped = {};
        rows.forEach((row) => {
            const key = `${row.item_type}:${row.item_index}`;
            if (!grouped[key]) grouped[key] = [];
            grouped[key].push(row);
        });
        // 统计各索引的 agree/disagree/comment 数量
        const summary = {};
        rows.forEach((row) => {
            const key = `${row.item_type}:${row.item_index}`;
            if (!summary[key]) summary[key] = { agree: 0, disagree: 0, comment: 0, resolved: false };
            if (row.action_type === 'agree') summary[key].agree += 1;
            else if (row.action_type === 'disagree') summary[key].disagree += 1;
            else if (row.action_type === 'comment') summary[key].comment += 1;
            if (row.is_resolved) summary[key].resolved = true;
        });
        res.json({ comments: rows, grouped, summary });
    } catch (error) {
        console.error('[ERROR] Failed to list review comments:', error);
        res.status(500).json({ error: 'Failed to list comments.' });
    }
});

// PUT /api/contracts/comments/:id — 更新/解决批注
router.put('/comments/:id', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const { comment_text, is_resolved } = req.body;

    try {
        const comment = await db('review_comments').where({ id: req.params.id, user_id: Number(userId) }).first();
        if (!comment) return res.status(404).json({ error: 'Comment not found.' });

        const update = {};
        if (comment_text !== undefined) update.comment_text = comment_text;
        if (is_resolved !== undefined) update.is_resolved = is_resolved;
        update.updated_at = db.fn.now();

        await db('review_comments').where({ id: req.params.id }).update(update);
        const updated = await db('review_comments').where({ id: req.params.id }).first();
        res.json(updated);
    } catch (error) {
        console.error('[ERROR] Failed to update review comment:', error);
        res.status(500).json({ error: 'Failed to update comment.' });
    }
});

// DELETE /api/contracts/comments/:id — 删除批注
router.delete('/comments/:id', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    try {
        const deleted = await db('review_comments').where({ id: req.params.id, user_id: Number(userId) }).del();
        if (!deleted) return res.status(404).json({ error: 'Comment not found.' });
        res.json({ ok: true });
    } catch (error) {
        console.error('[ERROR] Failed to delete review comment:', error);
        res.status(500).json({ error: 'Failed to delete comment.' });
    }
});

// GET /api/contracts/:id/risk-score — 计算风险评分仪表盘
router.get('/:id/risk-score', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;
    const contract = await findOwnedContract(req.params.id, userId);
    if (!contract) return res.status(404).json({ error: 'Contract not found.' });

    try {
        const reviewData = contract.analysis_result
            ? JSON.parse(contract.analysis_result)
            : parseJsonField(contract.analysis_partial_result, {});

        const disputes = reviewData.dispute_points || [];
        const missing = reviewData.missing_clauses || [];
        const suggestions = reviewData.modification_suggestions || [];
        const breach = reviewData.breach_cost_analysis || [];
        const party = reviewData.party_review || [];
        const laws = reviewData.relevant_laws || [];

        // 风险评分算法
        const severityScore = (severity) => ({ '高': 100, '中': 55, '低': 20 })[String(severity).trim()] || 40;

        // 1. 风险总分 (0-100)
        const totalItems = disputes.length + missing.length + suggestions.length + breach.length;
        const rawTotalScore = disputes.reduce((sum, d) => sum + severityScore(d.severity), 0)
            + missing.length * 50 + breach.reduce((sum, b) => sum + 60, 0);
        const overallScore = totalItems > 0
            ? Math.min(100, Math.round(rawTotalScore / totalItems))
            : 0;

        // 2. 按类别统计
        const categoryRisk = {
            dispute_points: { label: '风险争议点', count: disputes.length, avgSeverity: 0, items: [] },
            missing_clauses: { label: '缺失条款', count: missing.length, avgSeverity: 0, items: [] },
            breach_cost_analysis: { label: '违约成本', count: breach.length, avgSeverity: 0, items: [] },
            party_review: { label: '主体审查', count: party.length, avgSeverity: 0, items: [] },
        };

        // 各风险点的严重程度分布
        const severityDist = { 高: 0, 中: 0, 低: 0 };
        disputes.forEach((d) => {
            const s = String(d.severity || '中').trim();
            if (severityDist[s] !== undefined) severityDist[s] += 1;
            else severityDist['中'] += 1;
        });

        // 类别平均严重度
        if (disputes.length > 0) {
            const avg = Math.round(disputes.reduce((sum, d) => sum + severityScore(d.severity), 0) / disputes.length);
            categoryRisk.dispute_points.avgSeverity = avg;
            categoryRisk.dispute_points.items = disputes.map((d, i) => ({
                index: i, title: d.title || d.type || `风险点${i + 1}`,
                severity: d.severity || '中', score: severityScore(d.severity),
            }));
        }
        if (missing.length > 0) {
            categoryRisk.missing_clauses.avgSeverity = 50;
            categoryRisk.missing_clauses.items = missing.map((d, i) => ({
                index: i, title: d.title || d.clause_type || `缺失条款${i + 1}`,
                severity: '中', score: 50,
            }));
        }
        if (breach.length > 0) {
            categoryRisk.breach_cost_analysis.avgSeverity = 60;
            categoryRisk.breach_cost_analysis.items = breach.map((d, i) => ({
                index: i, title: d.scenario || `违约场景${i + 1}`,
                severity: '中', score: 60,
            }));
        }
        if (party.length > 0) {
            const partyAvg = Math.round(party.reduce((sum) => sum + 20, 0) / party.length);
            categoryRisk.party_review.avgSeverity = partyAvg;
        }

        // 3. 整体风险等级
        let overallLevel = 'low';
        let overallLabel = '低风险';
        if (severityDist['高'] > 0 || overallScore >= 70) {
            overallLevel = 'high'; overallLabel = '高风险';
        } else if (severityDist['中'] > 0 || overallScore >= 40) {
            overallLevel = 'medium'; overallLabel = '中风险';
        }

        // 4. 雷达图数据（五维度）
        const radarData = [
            { axis: '法律风险', value: Math.min(100, severityDist['高'] * 100 + severityDist['中'] * 50 + disputes.length * 10) },
            { axis: '条款完整性', value: Math.max(0, 100 - missing.length * 20) },
            { axis: '修改建议', value: suggestions.length > 0 ? Math.min(80, suggestions.length * 15) : 0 },
            { axis: '违约风险', value: breach.length > 0 ? Math.min(100, breach.length * 30 + 20) : 0 },
            { axis: '主体合规', value: Math.max(10, 100 - party.length * 15) },
        ];

        res.json({
            overallScore,
            overallLevel,
            overallLabel,
            severityDist,
            categoryRisk,
            radarData,
            stats: {
                totalDisputes: disputes.length,
                totalMissing: missing.length,
                totalSuggestions: suggestions.length,
                totalBreach: breach.length,
                totalParty: party.length,
                totalLaws: laws.length,
            },
        });
    } catch (error) {
        console.error('[ERROR] Failed to compute risk score:', error);
        res.status(500).json({ error: 'Failed to compute risk score.' });
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
                editorConfig: buildWpsEditorConfig(contractRecord, ext),
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

// ========== 开启在线编辑模式 ==========
// POST /api/contracts/:id/enable-edit
router.post('/:id/enable-edit', async (req, res) => {
    try {
        const contractId = Number(req.params.id);
        const contract = await db('contracts').where({ id: contractId }).first();
        if (!contract) return res.status(404).json({ error: 'Contract not found.' });

        await db('contracts').where({ id: contractId }).update({ edit_enabled: true });

        const ext = String(contract.original_filename || '').toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx';
        const editorConfig = buildWpsEditorConfig(contract, ext);

        res.json({ success: true, editorConfig });
    } catch (error) {
        console.error('[ERROR] enable-edit:', error);
        res.status(500).json({ error: 'Failed to enable edit mode.' });
    }
});

// ========== 获取最新编辑器配置（供刷新使用） ==========
// GET /api/contracts/:id/fresh-editor-config
router.get('/:id/fresh-editor-config', async (req, res) => {
    try {
        const contractId = Number(req.params.id);
        const contractRecord = await db('contracts').where({ id: contractId }).first();
        if (!contractRecord) return res.status(404).json({ error: 'Contract not found or you do not have permission to access it.' });

        const ext = String(contractRecord.original_filename || '').toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx';
        res.json({
            editorConfig: buildWpsEditorConfig(contractRecord, ext),
        });
    } catch (error) {
        console.error('[ERROR] fresh-editor-config:', error);
        res.status(500).json({ error: 'Failed to get fresh editor config.' });
    }
});

module.exports = router;
module.exports.setIoInstance = setIoInstance;
