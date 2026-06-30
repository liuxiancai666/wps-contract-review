const express = require('express');
const db = require('../database');
const { getAllTemplates } = require('../services/reviewTemplates');

const router = express.Router();

const getRequestUserId = (req) => {
    const raw = req.header('X-User-ID') || req.query?.userId;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
};

// GET /api/templates — 返回预设模板 + 用户自定义规则合并
router.get('/', async (req, res) => {
    try {
        const presets = getAllTemplates();
        const userId = getRequestUserId(req);

        let customRules = [];
        if (userId) {
            const rules = await db('review_rules')
                .where({ user_id: userId, is_enabled: true })
                .select('id', 'name', 'contract_type_keywords', 'review_points', 'core_purposes', 'prompt_rules', 'updated_at');

            customRules = rules.map((r) => ({
                id: `custom-${r.id}`,
                name: `📋 ${r.name}`,
                is_custom: true,
                custom_rule_id: r.id,
                contract_type_keywords: parseKeywords(r.contract_type_keywords),
                review_points: parseJsonField(r.review_points, []),
                core_purposes: parseJsonField(r.core_purposes, []),
                prompt_rules: parseJsonField(r.prompt_rules, []),
                report_sections: ['risk_summary', 'modification_suggestions', 'breach_cost_analysis', 'missing_clauses', 'citations'],
            }));
        }

        res.json([...presets, ...customRules]);
    } catch (error) {
        console.error('[Templates] Merge error:', error);
        // Fallback: return presets only
        res.json(getAllTemplates());
    }
});

function parseJsonField(value, fallback = []) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch { return fallback; }
}

function parseKeywords(value) {
    if (!value) return [];
    return String(value).split(/[,，、\s]+/).filter(Boolean);
}

module.exports = router;
