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

module.exports = router;
module.exports.setIoInstance = setIoInstance;
