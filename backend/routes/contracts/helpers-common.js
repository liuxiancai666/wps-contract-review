// 解析 JSON 字段
function parseJsonField(value, fallback = {}) {
    if (!value) return fallback;
    try { return JSON.parse(value); }
    catch { return fallback; }
}

// 获取请求用户 ID
function requireRequestUserId(req, res) {
    const userId = parseInt(req.headers['x-user-id'], 10);
    if (!userId || userId <= 0) {
        res.status(401).json({ error: 'User ID is required.' });
        return null;
    }
    return userId;
}

module.exports = { parseJsonField, requireRequestUserId };
