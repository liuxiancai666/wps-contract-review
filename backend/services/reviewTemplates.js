const path = require('path');
const fs = require('fs');

const templatesPath = path.join(__dirname, '..', 'data', 'reviewTemplates.json');

const loadTemplates = () => {
    if (!fs.existsSync(templatesPath)) return [];
    return JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
};

const getAllTemplates = () => loadTemplates();

// getTemplateById handles preset IDs ("labor", "lease") and custom rule IDs ("custom-123")
// For custom rules, it returns a template-like shape with is_custom=true so callers can
// look up the actual rule from the database when needed.
const getTemplateById = (id) => {
    if (!id) return null;
    // Try preset templates first
    const presets = loadTemplates();
    const preset = presets.find((t) => t.id === id);
    if (preset) return preset;
    // Custom rule format: "custom-<number>"
    if (String(id).startsWith('custom-')) {
        const numericId = Number(String(id).replace('custom-', ''));
        if (Number.isInteger(numericId) && numericId > 0) {
            return {
                id: String(id),
                is_custom: true,
                custom_rule_id: numericId,
                name: `自定义规则 #${numericId}`,
                review_points: [],
                core_purposes: [],
                prompt_rules: [],
                report_sections: ['risk_summary', 'modification_suggestions', 'breach_cost_analysis', 'missing_clauses', 'citations'],
            };
        }
    }
    return null;
};

const matchTemplate = (contractType = '', text = '') => {
    const templates = loadTemplates();
    const haystack = `${contractType}\n${text}`.toLowerCase();
    let best = templates.find((template) => template.id === 'general') || templates[0];
    let bestScore = -1;

    for (const template of templates) {
        const score = (template.contract_type_keywords || []).reduce((sum, keyword) => (
            haystack.includes(String(keyword).toLowerCase()) ? sum + 1 : sum
        ), 0);
        if (score > bestScore) {
            best = template;
            bestScore = score;
        }
    }
    return best;
};

module.exports = {
    getAllTemplates,
    getTemplateById,
    matchTemplate,
};
