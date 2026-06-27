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
    if (text.length < 200) return [{ index: 0, title: '全文', content: text }];
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
        const chunkSize = 800, overlap = 100, newSections = [];
        for (let i = 0; i < text.length; i += chunkSize - overlap) {
            const content = text.slice(i, Math.min(i + chunkSize, text.length)).trim();
            if (content.length >= 100) newSections.push({ index: newSections.length, title: `第${newSections.length + 1}部分`, content });
            if (i + chunkSize >= text.length) break;
        }
        return newSections;
    }
    const batches = [];
    let currentBatch = { sections: [], combinedContent: '', startIdx: 0 };
    let currentSize = 0;
    const TARGET_SIZE = 1200;
    for (const section of sections) {
        if (currentSize + section.content.length > TARGET_SIZE && currentSize > 0) { batches.push(currentBatch); currentBatch = { sections: [], combinedContent: '', startIdx: batches.length }; currentSize = 0; }
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
    const batchResults = await Promise.all(prompts.map(p => callJsonLLMFn(p)));
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
        await emitAnalysisProgress(null, contractId, { step: 'llm_review', status: 'running', message: 'AI 正在分章节深度审查合同，请耐心等待...' });

        // 按章节/条款拆分合同正文为若干 batch，并行审查每个 batch
        const batches = splitContractIntoSections(plainText);
        const batchResult = await batchReviewSections(batches, template, userPerspective, relevantKnowledge, reviewPoints, corePurposes, callJsonLLM);

        // 构造 analysisResult（合并 batch 结果 + 公司主体审查 + 整体摘要）
        const analysisResult = {
            ...normalizeAnalysisResult({ dispute_points: batchResult.dispute_points }),
            missing_clauses: batchResult.missing_clauses || [],
            modification_suggestions: batchResult.modification_suggestions || [],
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

module.exports = router;
module.exports.setIoInstance = setIoInstance;
