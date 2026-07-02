console.log('='.repeat(60));
console.log('  前端函数单元测试');
console.log('='.repeat(60));
console.log('');

const normalizeSearchText = (text) => {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/[：]/g, ':')
        .replace(/[，]/g, ',')
        .replace(/[。]/g, '.')
        .replace(/[、]/g, ',')
        .replace(/[；]/g, ';')
        .replace(/[！]/g, '!')
        .replace(/[？]/g, '?')
        .replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '')
        .trim();
};

const normalizeCandidate = (text) => String(text || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[：]/g, ':')
    .replace(/[，]/g, ',')
    .replace(/[。]/g, '.')
    .replace(/\s+/g, '')
    .trim();

const splitCandidateSentences = (text) => String(text || '')
    .split(/(?<=[。！？；;.!?])|\n+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 6);

const buildSuggestionCandidates = (originalText, item = {}) => {
    const candidates = [
        originalText,
        item.anchor_hint,
        item.original_clause,
        item.clause,
        ...splitCandidateSentences(originalText),
    ];
    const compact = normalizeCandidate(originalText);
    if (compact && compact !== originalText) candidates.push(compact);
    if (originalText && originalText.length > 80) {
        candidates.push(originalText.slice(0, 80));
        candidates.push(originalText.slice(-80));
        candidates.push(originalText.slice(0, 50));
        candidates.push(originalText.slice(-50));
    }
    if (originalText && originalText.length > 50) {
        candidates.push(originalText.slice(10, 60));
        candidates.push(originalText.slice(-60, -10));
    }
    const seen = new Set();
    return candidates
        .map((candidate) => String(candidate || '').trim())
        .filter((candidate) => candidate.length >= 4)
        .filter((candidate) => {
            const key = normalizeCandidate(candidate);
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
};

let passedCount = 0;
let failedCount = 0;

function assert(condition, message) {
    if (condition) {
        passedCount++;
        console.log(`  ✓ ${message}`);
    } else {
        failedCount++;
        console.log(`  ✗ ${message}`);
    }
}

// 测试 1: normalizeSearchText - 基础空白处理
console.log('📝 测试 1: normalizeSearchText - 基础空白处理');
const result1 = normalizeSearchText('  Hello   World  ');
assert(result1 === 'Hello World', `多重空白归一化: "${result1}"`);
console.log('');

// 测试 2: normalizeSearchText - 中文标点归一化
console.log('📝 测试 2: normalizeSearchText - 中文标点归一化');
const result2 = normalizeSearchText('你好：这是测试，失败。');
assert(result2 === '你好:这是测试,失败.', `中文标点: "${result2}"`);
console.log('');

// 测试 3: normalizeSearchText - 引号归一化
console.log('📝 测试 3: normalizeSearchText - 引号归一化');
const result3 = normalizeSearchText('“测试”和‘单引号’');
assert(result3 === '"测试"和\'单引号\'', `引号: "${result3}"`);
console.log('');

// 测试 4: normalizeSearchText - 零宽字符和不间断空格
console.log('📝 测试 4: normalizeSearchText - 零宽字符和不间断空格');
const result4 = normalizeSearchText('Hello\u200BWorld\u00A0Test');
assert(result4 === 'HelloWorldTest', `移除特殊字符: "${result4}"`);
console.log('');

// 测试 5: normalizeCandidate - 紧凑模式
console.log('📝 测试 5: normalizeCandidate - 紧凑模式（去空白）');
const result5 = normalizeCandidate('这是 一段 测试 文本');
assert(result5 === '这是一段测试文本', `紧凑模式: "${result5}"`);
console.log('');

// 测试 6: splitCandidateSentences - 句子拆分
console.log('📝 测试 6: splitCandidateSentences - 句子拆分');
const result6 = splitCandidateSentences('第一句。第二句！第三句?第四句;');
assert(result6.length >= 3, `拆分出 ${result6.length} 个句子（预期>=3）`);
assert(result6[0] === '第一句', `第一句正确: "${result6[0]}"`);
console.log('');

// 测试 7: buildSuggestionCandidates - 短文本
console.log('📝 测试 7: buildSuggestionCandidates - 短文本');
const result7 = buildSuggestionCandidates('简单测试文本');
assert(result7.length >= 1, `短文本生成 ${result7.length} 个候选`);
assert(result7.includes('简单测试文本'), '包含原始文本');
console.log('');

// 测试 8: buildSuggestionCandidates - 长文本多种候选
console.log('📝 测试 8: buildSuggestionCandidates - 长文本多种候选');
const longText = '这是一段非常长的测试文本，用于验证候选生成功能。' +
    '它包含多个句子，每个句子都应该被拆分。' +
    '还有标点符号，以及各种不同的内容。' +
    '继续添加更多内容以达到足够长度。';
const result8 = buildSuggestionCandidates(longText);
assert(result8.length >= 5, `长文本生成 ${result8.length} 个候选（预期>=5）`);
console.log(`  候选列表（前5个）:`);
result8.slice(0, 5).forEach((c, i) => console.log(`    ${i + 1}. "${c.slice(0, 30)}..."`));
console.log('');

// 测试 9: buildSuggestionCandidates - 去重
console.log('📝 测试 9: buildSuggestionCandidates - 去重验证');
const result9 = buildSuggestionCandidates('重复 重复 重复');
const seen = new Set();
const hasDuplicate = result9.some(c => {
    const key = normalizeCandidate(c);
    if (seen.has(key)) return true;
    seen.add(key);
    return false;
});
assert(!hasDuplicate, `候选列表无重复（共 ${result9.length} 个）`);
console.log('');

// 测试 10: buildSuggestionCandidates - 包含 item 属性
console.log('📝 测试 10: buildSuggestionCandidates - 包含 item 属性');
const result10 = buildSuggestionCandidates('原文', {
    anchor_hint: '锚点提示',
    original_clause: '原始条款',
    clause: '条款',
});
assert(result10.some(c => c.includes('锚点提示')), '包含 anchor_hint');
assert(result10.some(c => c.includes('原始条款')), '包含 original_clause');
assert(result10.some(c => c.includes('条款')), '包含 clause');
console.log('');

// 测试 11: 边界情况 - 空输入
console.log('📝 测试 11: 边界情况 - 空输入');
assert(normalizeSearchText('') === '', '空字符串归一化');
assert(normalizeSearchText(null) === '', 'null 归一化');
assert(normalizeSearchText(undefined) === '', 'undefined 归一化');
assert(buildSuggestionCandidates('').length === 0, '空文本无候选');
console.log('');

// 测试 12: 边界情况 - 短文本过滤
console.log('📝 测试 12: 边界情况 - 短文本过滤（<4字符）');
const result12 = buildSuggestionCandidates('短');
assert(result12.length === 0, `少于4字符的文本被过滤（候选数: ${result12.length}）`);
console.log('');

// 测试 13: 中文标点混合场景
console.log('📝 测试 13: 中文标点混合场景');
const complexText = '甲方：北京某某公司；乙方：上海某某公司。' +
    '本合同自签订之日起生效。' +
    '如有争议，双方应友好协商解决。';
const result13 = buildSuggestionCandidates(complexText);
assert(result13.length >= 4, `复杂文本生成 ${result13.length} 个候选`);
assert(result13.some(c => c.includes('北京某某公司')), '包含甲方信息');
console.log('');

console.log('='.repeat(60));
console.log(`  测试结果: 通过 ${passedCount} / ${passedCount + failedCount}`);
if (failedCount > 0) {
    console.log(`  ⚠️  失败 ${failedCount} 个测试`);
} else {
    console.log('  ✓ 所有测试通过！');
}
console.log('='.repeat(60));
