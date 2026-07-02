const assert = require('node:assert/strict');
const test = require('node:test');

const {
    enrichRiskLocations,
} = require('./riskLocation');

test('为可匹配的风险点补充条款编号、章节标题和字符区间', () => {
    const contractText = [
        '第一章 基本信息',
        '第一条 合同目的',
        '双方确认合作事项。',
        '',
        '第二章 违约责任',
        '第八条 违约金',
        '乙方逾期交付的，应按合同总价的30%支付违约金。',
    ].join('\n');

    const [risk] = enrichRiskLocations([{
        title: '违约金比例过高',
        original_clause: '乙方逾期交付的，应按合同总价的30%支付违约金。',
    }], contractText);

    assert.equal(risk.location_verified, true);
    assert.equal(risk.clause_ref, '第八条 违约金');
    assert.equal(risk.section_title, '第二章 违约责任');
    assert.equal(risk.location_text, '乙方逾期交付的，应按合同总价的30%支付违约金。');
    assert.equal(contractText.slice(risk.location_start, risk.location_end), risk.location_text);
});

test('无法匹配时保留原风险点并标记未验证', () => {
    const [risk] = enrichRiskLocations([{
        title: '不存在的风险',
        original_clause: '这段原文不在合同中。',
        clause_ref: '第九条',
    }], '第一条 合同目的\n双方确认合作事项。');

    assert.equal(risk.location_verified, false);
    assert.equal(risk.clause_ref, '第九条');
    assert.equal(risk.location_start, undefined);
});
