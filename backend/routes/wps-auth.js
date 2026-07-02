/**
 * WPS WebOffice SDK Auth 验证代理
 * SDK 在初始化时发送 POST /office/v5/ai/ingress/privilege/auth
 * 后端代理到 o.wpsgo.com 并附加 Authorization: Bearer *** */
const express = require('express');
const router = express.Router();

const WPS_APP_ID = process.env.WPS_APP_ID || 'SX20260701SKURKN';
const WPS_ENDPOINT = process.env.WPS_ENDPOINT || 'https://o.wpsgo.com';

// POST /office/v5/ai/ingress/privilege/auth
// 代理到 WPS 云 + 附加 Authorization header
router.post('/ingress/privilege/auth', async (req, res) => {
    try {
        const body = { ...req.body, appId: WPS_APP_ID };
        const response = await fetch(`${WPS_ENDPOINT}/office/v5/ai/ingress/privilege/auth`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${WPS_APP_ID}`,
            },
            body: JSON.stringify(body),
        });
        const data = await response.text();
        res.status(response.status).type('application/json').send(data);
    } catch (error) {
        console.error('[WPS-AUTH] Proxy error:', error.message);
        res.status(500).json({ error: 'WPS auth proxy failed: ' + error.message });
    }
});

module.exports = router;
