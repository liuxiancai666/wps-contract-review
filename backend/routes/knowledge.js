const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const mammoth = require('mammoth');
const pdf = require('pdf-parse');
const {
    importKnowledgeEntries,
    searchVectorDocuments,
    deleteKnowledgeDocuments,
    listKnowledgeDocuments,
    seedLawsFromMarkdown,
    seedCasesFromJson,
} = require('../services/vectorStore');
const { parseLegalMarkdown, parseLegalMarkdownFile } = require('../services/legalMarkdownParser');

const router = express.Router();
const BATCH_IMPORT_FILE_LIMIT = Math.max(1, Number(process.env.KNOWLEDGE_BATCH_FILE_LIMIT || 200));
const BATCH_IMPORT_ENTRY_SIZE = Math.max(1, Number(process.env.KNOWLEDGE_BATCH_ENTRY_SIZE || 50));
const upload = multer({
    dest: path.join(__dirname, '..', 'uploads', 'knowledge'),
    limits: {
        files: BATCH_IMPORT_FILE_LIMIT,
        fileSize: Math.max(1024 * 1024, Number(process.env.KNOWLEDGE_IMPORT_FILE_SIZE_LIMIT || 50 * 1024 * 1024)),
    },
});
const legalTemplatePath = path.join(__dirname, '..', 'data', '法律法规模版.md');
const caseTemplatePath = path.join(__dirname, '..', 'data', '裁判文书模版.json');
const projectRoot = path.resolve(__dirname, '..', '..');

const extractTextFromFile = async (filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.docx') {
        const { value } = await mammoth.extractRawText({ path: filePath });
        return value;
    }
    if (ext === '.pdf') {
        const data = await pdf(fs.readFileSync(filePath));
        return data.text;
    }
    return fs.readFileSync(filePath, 'utf8');
};

const looksLikeLegalMarkdown = (content) => String(content || '').includes('<!-- INFO END -->')
    && /^第[〇零一二两三四五六七八九十百千万亿\d]+条/m.test(content);

const normalizeKnowledgeEntries = (incoming) => {
    const normalized = [];
    for (const entry of incoming) {
        if (!entry) continue;
        const sourceType = entry.source_type || entry.sourceType || entry.type;
        const isLegalMarkdown = entry.format === 'legal_markdown'
            || entry.format === 'markdown'
            || sourceType === 'law_markdown'
            || (sourceType === 'law' && looksLikeLegalMarkdown(entry.content));

        if (isLegalMarkdown) {
            normalized.push(...parseLegalMarkdown(entry.content, {
                sourceFile: entry.source_name || entry.sourceName || entry.title || '',
                sourceUrl: entry.source_url || entry.sourceUrl || '',
            }));
            continue;
        }
        normalized.push(entry);
    }
    return normalized;
};

// 尝试从 git 远程拉取最新的数据文件
const tryPullGitData = () => {
    const gitDir = path.join(projectRoot, '.git');
    if (!fs.existsSync(gitDir)) {
        console.log('[Knowledge Rebuild] No .git directory found. Skipping git pull.');
        return false;
    }
    try {
        console.log('[Knowledge Rebuild] Attempting git fetch origin...');
        execSync('git fetch origin', { cwd: projectRoot, stdio: 'pipe', timeout: 30000 });
        // 先尝试 origin/v2.0, 再试 origin/main
        const remoteRef = execSync('git ls-remote origin HEAD', { cwd: projectRoot, stdio: 'pipe', timeout: 10000 })
            .toString().trim();
        // 使用 origin/v2.0（含代码和数据的完整分支）
        for (const branch of ['origin/v2.0', 'origin/main', 'origin/master']) {
            const checkCmd = `git rev-parse --verify ${branch} --`;
            try {
                execSync(checkCmd, { cwd: projectRoot, stdio: 'pipe', timeout: 5000 });
                console.log(`[Knowledge Rebuild] Checking out data files from ${branch}...`);
                execSync(`git checkout ${branch} -- backend/data/`, { cwd: projectRoot, stdio: 'pipe', timeout: 30000 });
                console.log(`[Knowledge Rebuild] Successfully pulled data from ${branch}.`);
                return true;
            } catch {
                continue;
            }
        }
        console.log('[Knowledge Rebuild] No remote branch with data found.');
        return false;
    } catch (error) {
        console.log(`[Knowledge Rebuild] Git pull failed: ${error.message}. Using local data.`);
        return false;
    }
};

// POST /api/knowledge/rebuild — 重建向量数据库
router.post('/rebuild', async (req, res) => {
    try {
        console.log('[Knowledge Rebuild] ===== Starting rebuild... =====');

        // 1. 先尝试从 git 拉取最新数据文件
        tryPullGitData();

        // 2. 删除全部知识向量
        const { deleteKnowledgeDocuments } = require('../services/vectorStore');
        const delResult = await deleteKnowledgeDocuments({ sourceType: 'law' });
        const delCaseResult = await deleteKnowledgeDocuments({ sourceType: 'case' });
        const delRuleResult = await deleteKnowledgeDocuments({ sourceType: 'rule' });
        const delGuideResult = await deleteKnowledgeDocuments({ sourceType: 'guide' });
        console.log(`[Knowledge Rebuild] Deleted: law=${delResult.deleted}, case=${delCaseResult.deleted}, rule=${delRuleResult.deleted}, guide=${delGuideResult.deleted}`);

        // 3. 设置环境变量强制重建（绕过 seed 函数的已有数据保护检查）
        process.env.FORCE_RESEED_LAWS = 'true';
        process.env.FORCE_RESEED_CASES = 'true';
        const lawResult = await seedLawsFromMarkdown();
        const caseResult = await seedCasesFromJson();
        // 清理环境变量
        delete process.env.FORCE_RESEED_LAWS;
        delete process.env.FORCE_RESEED_CASES;

        console.log('[Knowledge Rebuild] ===== Rebuild complete. =====');
        res.json({
            message: '向量数据库重建完成。',
            gitPull: fs.existsSync(path.join(projectRoot, '.git')),
            laws: lawResult,
            cases: caseResult,
            deleted: {
                law: delResult.deleted,
                case: delCaseResult.deleted,
                rule: delRuleResult.deleted,
                guide: delGuideResult.deleted,
            },
        });
    } catch (error) {
        console.error('[Knowledge Rebuild] Failed:', error);
        res.status(500).json({ error: `重建向量数据库失败: ${error.message}` });
    }
});

router.get('/template', (req, res) => {
    const templateType = String(req.query.type || '').trim().toLowerCase();
    const templatePath = templateType === 'case' ? caseTemplatePath : legalTemplatePath;
    const downloadName = templateType === 'case' ? '裁判文书模版.json' : '法律法规模版.md';
    if (!fs.existsSync(templatePath)) {
        return res.status(404).json({ error: 'Knowledge template not found.' });
    }
    res.download(templatePath, downloadName);
});

router.get('/case-template', (req, res) => {
    if (!fs.existsSync(caseTemplatePath)) {
        return res.status(404).json({ error: 'Case knowledge template not found.' });
    }
    res.download(caseTemplatePath, '裁判文书模版.json');
});

router.get('/search', async (req, res) => {
    try {
        const query = String(req.query.q || req.query.query || '').trim();
        const sourceTypes = String(req.query.types || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);

        const results = await searchVectorDocuments(query || '合同 法律 条文 裁判 文书', {
            limit: Number(req.query.limit || 20),
            sourceTypes,
            rerank: String(req.query.rerank || '').toLowerCase() !== 'false',
        });

        res.json(results);
    } catch (error) {
        console.error('[ERROR] Knowledge vector search failed:', error);
        res.status(500).json({ error: 'Knowledge vector search failed.' });
    }
});

router.get('/list', async (req, res) => {
    try {
        const result = await listKnowledgeDocuments({
            page: req.query.page,
            pageSize: req.query.pageSize,
            query: req.query.q || req.query.query || '',
            sourceType: req.query.type || req.query.source_type || '',
        });
        res.json(result);
    } catch (error) {
        console.error('[ERROR] Knowledge list failed:', error);
        res.status(500).json({ error: 'Knowledge list failed.' });
    }
});

router.post('/import', async (req, res) => {
    const incoming = Array.isArray(req.body) ? req.body : req.body?.laws || req.body?.documents;
    if (!Array.isArray(incoming)) {
        return res.status(400).json({ error: 'Expected an array or { laws/documents: [...] }.' });
    }

    const normalizedEntries = normalizeKnowledgeEntries(incoming);
    const validEntries = normalizedEntries.filter((entry) => {
        if (!entry || typeof entry.title !== 'string') return false;
        if (Array.isArray(entry.key_clauses)) {
            return entry.key_clauses.every((clause) => clause && clause.id && clause.content);
        }
        return typeof entry.content === 'string' && entry.content.trim();
    });

    if (validEntries.length !== normalizedEntries.length) {
        return res.status(400).json({
            error: 'Each entry requires title plus either key_clauses[] or content. Legal Markdown entries must follow the provided template.',
        });
    }

    try {
        const imported = await importKnowledgeEntries(validEntries);
        res.status(201).json(imported);
    } catch (error) {
        console.error('[ERROR] Knowledge import failed:', error);
        res.status(500).json({ error: 'Knowledge import failed.' });
    }
});

router.post('/batch-import', upload.array('files', BATCH_IMPORT_FILE_LIMIT), async (req, res) => {
    const files = req.files || [];
    const sourceType = req.body.source_type || req.body.sourceType || 'case';
    const category = req.body.category || '';
    const sourceUrl = req.body.source_url || req.body.sourceUrl || '';

    if (files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded for batch import.' });
    }

    try {
        const totals = {
            imported: 0,
            chunks: 0,
            deduped: 0,
            files: 0,
            failed: [],
            vectorStore: 'sqlite-fallback',
        };
        let entries = [];

        const flushEntries = async () => {
            if (entries.length === 0) return;
            const result = await importKnowledgeEntries(entries);
            totals.imported += result.imported || 0;
            totals.chunks += result.chunks || 0;
            totals.deduped += result.deduped || 0;
            totals.vectorStore = result.vectorStore || totals.vectorStore;
            entries = [];
        };

        for (const file of files) {
            const sourceName = Buffer.from(file.originalname, 'latin1').toString('utf8');
            try {
                if (sourceType === 'law' && path.extname(file.originalname).toLowerCase() === '.md') {
                    entries.push(...parseLegalMarkdownFile(file.path, {
                        sourceFile: sourceName,
                        sourceUrl,
                    }));
                } else {
                    const content = await extractTextFromFile(file.path);
                    entries.push({
                        source_type: sourceType,
                        title: req.body.title || sourceName,
                        category,
                        source_name: sourceName,
                        source_url: sourceUrl,
                        content,
                        metadata: {
                            original_filename: sourceName,
                            imported_by: 'batch-import',
                        },
                    });
                }
                totals.files += 1;
                if (entries.length >= BATCH_IMPORT_ENTRY_SIZE) {
                    await flushEntries();
                }
            } catch (error) {
                totals.failed.push({ file: sourceName, error: error.message });
            }
        }
        await flushEntries();
        res.status(totals.failed.length ? 207 : 201).json(totals);
    } catch (error) {
        console.error('[ERROR] Knowledge batch import failed:', error);
        res.status(500).json({ error: 'Knowledge batch import failed.' });
    } finally {
        for (const file of files) {
            fs.promises.unlink(file.path).catch(() => {});
        }
    }
});

router.delete('/', async (req, res) => {
    try {
        const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
        const sourceIds = Array.isArray(req.body?.source_ids || req.body?.sourceIds)
            ? (req.body.source_ids || req.body.sourceIds).filter(Boolean)
            : [];
        const sourceType = String(req.body?.source_type || req.body?.sourceType || '').trim();
        const title = String(req.body?.title || '').trim();
        const result = await deleteKnowledgeDocuments({ ids, sourceIds, sourceType, title });
        res.json(result);
    } catch (error) {
        console.error('[ERROR] Knowledge delete failed:', error);
        res.status(400).json({ error: error.message || 'Knowledge delete failed.' });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!id) return res.status(400).json({ error: 'Invalid knowledge id.' });
        const result = await deleteKnowledgeDocuments({ ids: [id] });
        res.json(result);
    } catch (error) {
        console.error('[ERROR] Knowledge delete by id failed:', error);
        res.status(400).json({ error: error.message || 'Knowledge delete failed.' });
    }
});

module.exports = router;
