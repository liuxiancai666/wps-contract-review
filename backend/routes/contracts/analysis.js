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

        // Step 4: AI 生成审查结论
        await emitAnalysisProgress(null, contractId, { step: 'llm_review', status: 'running', message: 'AI 正在深度审查合同，这是最耗时的步骤，请耐心等待...' });
        const prompt = `你是一名资深法务专家，请按审查模板对合同进行深度审查，并只输出 JSON。

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
{
  "dispute_points": [{"title":"风险标题","original_clause":"合同原文","legal_reference":"依据","dispute_rationale":"风险说明","plain_language":"大白话说明","severity":"高/中/低"}],
  "missing_clauses": [{"title":"缺失条款","description":"为什么缺失","suggested_clause":"可补充条款"}],
  "party_review": [{"title":"主体审查项","description":"审查结论","plain_language":"大白话说明"}],
  "modification_suggestions": [{"title":"建议标题","original_text":"合同中可定位的完整原文句子或段落","suggested_text":"可直接替换 original_text 的完整文本","reason":"修改理由","plain_language":"大白话说明","anchor_hint":"用于定位的短语"}],
  "breach_cost_analysis": [{"scenario":"违约场景","legal_basis":"依据","estimated_cost":"预计成本"}]
}

硬性要求：
- modification_suggestions 每一项必须包含 original_text 和 suggested_text。
- original_text 必须尽量逐字摘录合同原文中的完整句子或段落，用于 OnlyOffice 定位、书签和批注锚点。
- 必须逐条比对「法律与裁判依据」中每一条法律条文与合同对应条款，特别关注天数、期限、比例、金额、次数等强制性数字是否一致；合同条款与法律规定不一致的（例如法定 15 日被写成 30 日、试用期超过 6 个月、竞业限制超过 2 年），必须列入 dispute_points 并给出对应的 modification_suggestions，不得遗漏。
- 如果没有检索依据，不得编造法条或案例，只能说明"当前知识库未检索到直接依据"。
- 不输出自然语言解释，不输出 markdown。

合同原文：
---
${wrapContractContent(plainText)}
---`;

        const subjectSearchPrompt = `\n\n主体外部检索证据（来自 Bing/Baidu 搜索，已做基础真实性评分；只能把 verified=true 或可信度较高的结果作为主体审查线索，不能当作最终工商登记结论）：\n${companySearchContext || '未识别到可检索的公司主体名称。'}\n\n请额外输出 company_review 字段，结构为 [{"company_name":"公司名称","status":"已检索/未检索到可靠证据","evidence_summary":"基于外部搜索证据的主体核验摘要","authenticity":"真实性检测结论","sources":["URL"]}]。`;
        const analysisResult = normalizeAnalysisResult(await callJsonLLM(prompt + subjectSearchPrompt));
        analysisResult.relevant_laws = annotateKnowledgeUpdates(relevantKnowledge);
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
