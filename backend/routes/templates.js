const express = require('express');
const db = require('../database');
const { getAllTemplates } = require('../services/reviewTemplates');
const { getRequestUserId, parseJsonField } = require('../middleware/common');

const router = express.Router();

// GET /api/templates — 返回预设模板 + 用户自定义规则 + 系统默认规则
router.get('/', async (req, res) => {
    try {
        const presets = getAllTemplates();
        const userId = getRequestUserId(req);

        let customRules = [];
        if (userId) {
            const rules = await db('review_rules')
                .where(function () {
                    this.where({ user_id: userId, is_enabled: true })
                        .orWhere({ is_system: true, is_enabled: true }); // 系统默认规则对所有用户可见
                })
                .select('id', 'name', 'user_id', 'contract_type_keywords', 'review_points', 'core_purposes', 'prompt_rules', 'updated_at');

            customRules = rules.map((r) => ({
                id: `custom-${r.id}`,
                name: r.is_system ? `[系统] ${r.name}` : `📋 ${r.name}`,
                is_custom: true,
                is_system: r.is_system === true,
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
        res.json(getAllTemplates());
    }
});

function parseKeywords(value) {
    if (!value) return [];
    return String(value).split(/[,，、\s]+/).filter(Boolean);
}

module.exports = router;
