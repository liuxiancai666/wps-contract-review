const express = require('express');
const db = require('../database');

const router = express.Router();

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

// GET /api/rules — 列出当前用户的所有自定义规则（含系统默认规则）
router.get('/', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const rules = await db('review_rules')
            .where({ user_id: userId })
            .orWhere({ is_system: true }) // 系统默认规则对所有用户可见
            .orderBy([
                { column: 'is_system', order: 'desc' },  // 系统规则排在前面
                { column: 'updated_at', order: 'desc' },
            ])
            .select('id', 'user_id', 'name', 'contract_type_keywords', 'review_points', 'core_purposes', 'prompt_rules', 'is_enabled', 'is_system', 'created_at', 'updated_at');

        const deserialized = rules.map((r) => ({
            ...r,
            review_points: parseJsonField(r.review_points, []),
            core_purposes: parseJsonField(r.core_purposes, []),
            prompt_rules: parseJsonField(r.prompt_rules, []),
        }));
        res.json({ items: deserialized, total: deserialized.length });
    } catch (error) {
        console.error('[Rules] List error:', error);
        res.status(500).json({ error: '获取规则列表失败。' });
    }
});

// GET /api/rules/:id — 获取单条规则
router.get('/:id', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const rule = await db('review_rules').where({ id: req.params.id }).first();
        if (!rule) return res.status(404).json({ error: '规则未找到。' });
        if (!rule.is_system && rule.user_id !== userId) return res.status(403).json({ error: '规则未找到。' });

        rule.review_points = parseJsonField(rule.review_points, []);
        rule.core_purposes = parseJsonField(rule.core_purposes, []);
        rule.prompt_rules = parseJsonField(rule.prompt_rules, []);
        res.json(rule);
    } catch (error) {
        console.error('[Rules] Get error:', error);
        res.status(500).json({ error: '获取规则失败。' });
    }
});

// POST /api/rules — 新建规则
router.post('/', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const { name, contract_type_keywords, review_points, core_purposes, prompt_rules } = req.body;
        if (!name || !String(name).trim()) {
            return res.status(400).json({ error: '规则名称不能为空。' });
        }

        const [{ id }] = await db('review_rules').insert({
            user_id: userId,
            name: String(name).trim(),
            contract_type_keywords: String(contract_type_keywords || ''),
            review_points: JSON.stringify(review_points || []),
            core_purposes: JSON.stringify(core_purposes || []),
            prompt_rules: JSON.stringify(prompt_rules || []),
            is_enabled: true,
        }).returning('id');

        const rule = await db('review_rules').where({ id }).first();
        rule.review_points = parseJsonField(rule.review_points, []);
        rule.core_purposes = parseJsonField(rule.core_purposes, []);
        rule.prompt_rules = parseJsonField(rule.prompt_rules, []);
        res.status(201).json(rule);
    } catch (error) {
        console.error('[Rules] Create error:', error);
        res.status(500).json({ error: '创建规则失败。' });
    }
});

// PUT /api/rules/:id — 更新规则
router.put('/:id', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const existing = await db('review_rules').where({ id: req.params.id }).first();
        if (!existing) return res.status(404).json({ error: '规则未找到。' });
        if (existing.is_system) return res.status(403).json({ error: '系统默认规则不可修改。' });
        if (existing.user_id !== userId) return res.status(403).json({ error: '规则未找到或无权修改。' });

        const { name, contract_type_keywords, review_points, core_purposes, prompt_rules, is_enabled } = req.body;
        const updates = {};
        if (name !== undefined) updates.name = String(name).trim();
        if (contract_type_keywords !== undefined) updates.contract_type_keywords = String(contract_type_keywords);
        if (review_points !== undefined) updates.review_points = JSON.stringify(review_points);
        if (core_purposes !== undefined) updates.core_purposes = JSON.stringify(core_purposes);
        if (prompt_rules !== undefined) updates.prompt_rules = JSON.stringify(prompt_rules);
        if (is_enabled !== undefined) updates.is_enabled = Boolean(is_enabled);
        updates.updated_at = db.fn.now();

        await db('review_rules').where({ id: req.params.id }).update(updates);
        const rule = await db('review_rules').where({ id: req.params.id }).first();
        rule.review_points = parseJsonField(rule.review_points, []);
        rule.core_purposes = parseJsonField(rule.core_purposes, []);
        rule.prompt_rules = parseJsonField(rule.prompt_rules, []);
        res.json(rule);
    } catch (error) {
        console.error('[Rules] Update error:', error);
        res.status(500).json({ error: '更新规则失败。' });
    }
});

// DELETE /api/rules/:id — 删除规则
router.delete('/:id', async (req, res) => {
    const userId = requireRequestUserId(req, res);
    if (!userId) return;

    try {
        const existing = await db('review_rules').where({ id: req.params.id }).first();
        if (!existing) return res.status(404).json({ error: '规则未找到。' });
        if (existing.is_system) return res.status(403).json({ error: '系统默认规则不可删除。' });
        if (existing.user_id !== userId) return res.status(403).json({ error: '规则未找到或无权删除。' });

        await db('review_rules').where({ id: req.params.id }).del();
        res.json({ deleted: true });
    } catch (error) {
        console.error('[Rules] Delete error:', error);
        res.status(500).json({ error: '删除规则失败。' });
    }
});

function parseJsonField(value, fallback = []) {
    if (!value) return fallback;
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : fallback;
    } catch {
        return fallback;
    }
}

module.exports = router;
