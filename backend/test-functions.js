const unescapeXmlText = (value) => String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const escapeXmlText = (value) => String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const normalizeForDocxMatch = (text) => {
    const normalized = [];
    const indexMap = [];
    let normalizedIndex = 0;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (/[\u200B-\u200D\uFEFF\u00A0\s]/.test(char)) continue;
        if (/[“”]/.test(char)) {
            normalized.push('"');
            indexMap.push(i);
            normalizedIndex += 1;
            continue;
        }
        if (/[‘’]/.test(char)) {
            normalized.push("'");
            indexMap.push(i);
            normalizedIndex += 1;
            continue;
        }
        normalized.push(char);
        indexMap.push(i);
        normalizedIndex += 1;
    }
    return { value: normalized.join(''), indexMap };
};

const findDocxTextRange = (fullText, candidate) => {
    const exactIndex = fullText.indexOf(candidate);
    if (exactIndex >= 0) {
        return { start: exactIndex, end: exactIndex + candidate.length };
    }

    const normalizedFull = normalizeForDocxMatch(fullText);
    const normalizedCandidate = normalizeForDocxMatch(candidate).value;
    if (!normalizedCandidate) return null;

    const normalizedIndex = normalizedFull.value.indexOf(normalizedCandidate);
    if (normalizedIndex < 0) return null;

    const start = normalizedFull.indexMap[normalizedIndex];
    const end = normalizedFull.indexMap[normalizedIndex + normalizedCandidate.length - 1] + 1;
    return { start, end };
};

const replaceTextInXmlRuns = (xml, candidate, suggestedText) => {
    const textRunPattern = /<w:t\b([^>]*)>([\s\S]*?)<\/w:t>/g;
    const runs = [];
    let match;
    let fullText = '';

    while ((match = textRunPattern.exec(xml)) !== null) {
        const decodedText = unescapeXmlText(match[2]);
        runs.push({
            matchStart: match.index,
            matchEnd: match.index + match[0].length,
            attrs: match[1],
            rawText: match[2],
            text: decodedText,
            start: fullText.length,
            end: fullText.length + decodedText.length,
        });
        fullText += decodedText;
    }

    const range = findDocxTextRange(fullText, candidate);
    if (!range) return { xml, replaced: false };

    let inserted = false;
    const safeSuggestion = String(suggestedText || '').replace(/\r?\n+/g, ' ');
    const parts = [];
    let cursor = 0;

    for (const run of runs) {
        parts.push(xml.slice(cursor, run.matchStart));
        cursor = run.matchEnd;

        if (run.end <= range.start || run.start >= range.end) {
            parts.push(`<w:t${run.attrs}>${run.rawText}</w:t>`);
            continue;
        }

        const overlapStart = Math.max(range.start, run.start) - run.start;
        const overlapEnd = Math.min(range.end, run.end) - run.start;
        const before = run.text.slice(0, overlapStart);
        const after = run.text.slice(overlapEnd);
        let nextText = '';

        if (!inserted) {
            nextText = before + safeSuggestion;
            inserted = true;
        }
        if (run.end >= range.end) {
            nextText += after;
        }

        const attrs = /^\s/.test(nextText) || /\s$/.test(nextText)
            ? (run.attrs.includes('xml:space=') ? run.attrs : `${run.attrs} xml:space="preserve"`)
            : run.attrs;
        parts.push(`<w:t${attrs}>${escapeXmlText(nextText)}</w:t>`);
    }

    parts.push(xml.slice(cursor));
    return { xml: parts.join(''), replaced: true };
};

console.log('='.repeat(60));
console.log('  后端函数单元测试');
console.log('='.repeat(60));
console.log('');

// 测试 1: normalizeForDocxMatch
console.log('📝 测试 1: normalizeForDocxMatch - 文本归一化');
const testText1 = 'Hello\u200BWorld\u00A0test';
const result1 = normalizeForDocxMatch(testText1);
console.log(`  输入: "${testText1}"`);
console.log(`  归一化: "${result1.value}"`);
console.log(`  indexMap 长度: ${result1.indexMap.length}`);
console.log(`  ✓ ${result1.value === 'HelloWorldtest' ? '通过' : '失败'}: 零宽字符和不间断空格已移除`);
console.log('');

// 测试 2: 中文标点归一化
console.log('📝 测试 2: 中文引号归一化');
const testText2 = '“你好”世界';
const result2 = normalizeForDocxMatch(testText2);
console.log(`  输入: "${testText2}"`);
console.log(`  归一化: "${result2.value}"`);
console.log(`  ✓ ${result2.value === '"你好"世界' ? '通过' : '失败'}: 中文引号已转换为英文引号`);
console.log('');

// 测试 3: findDocxTextRange - 精确匹配
console.log('📝 测试 3: findDocxTextRange - 精确匹配');
const fullText = '这是一段测试文本，用于验证文本查找功能。';
const candidate3 = '测试文本';
const result3 = findDocxTextRange(fullText, candidate3);
console.log(`  全文: "${fullText}"`);
console.log(`  查找: "${candidate3}"`);
console.log(`  结果: start=${result3?.start}, end=${result3?.end}`);
console.log(`  匹配文本: "${fullText.slice(result3?.start, result3?.end)}"`);
console.log(`  ✓ ${result3 && fullText.slice(result3.start, result3.end) === candidate3 ? '通过' : '失败'}`);
console.log('');

// 测试 4: findDocxTextRange - 归一化匹配
console.log('📝 测试 4: findDocxTextRange - 归一化匹配（零宽字符）');
const fullText4 = '这是一段\u200B测试文本，用于验证。';
const candidate4 = '测试文本';
const result4 = findDocxTextRange(fullText4, candidate4);
console.log(`  全文含零宽字符: "${fullText4}"`);
console.log(`  查找: "${candidate4}"`);
console.log(`  结果: start=${result4?.start}, end=${result4?.end}`);
console.log(`  匹配文本: "${fullText4.slice(result4?.start, result4?.end)}"`);
console.log(`  ✓ ${result4 ? '通过' : '失败'}: 包含零宽字符的文本也能匹配`);
console.log('');

// 测试 5: replaceTextInXmlRuns - 单个 run 替换
console.log('📝 测试 5: replaceTextInXmlRuns - 单个 run 替换');
const xml5 = '<w:r><w:t>Hello World</w:t></w:r>';
const result5 = replaceTextInXmlRuns(xml5, 'World', 'Everyone');
console.log(`  输入: ${xml5}`);
console.log(`  替换 World -> Everyone`);
console.log(`  输出: ${result5.xml}`);
console.log(`  ✓ ${result5.replaced ? '通过' : '失败'}: 替换成功=${result5.replaced}`);
console.log(`  ✓ ${result5.xml.includes('Hello Everyone') ? '通过' : '失败'}: 替换内容正确`);
console.log('');

// 测试 6: replaceTextInXmlRuns - 跨 run 替换
console.log('📝 测试 6: replaceTextInXmlRuns - 跨 run 替换');
const xml6 = '<w:r><w:t>Hello </w:t></w:r><w:r><w:t>World</w:t></w:r>';
const result6 = replaceTextInXmlRuns(xml6, 'Hello World', 'Hi Everyone');
console.log(`  输入: ${xml6}`);
console.log(`  替换 "Hello World" -> "Hi Everyone"`);
console.log(`  输出: ${result6.xml}`);
console.log(`  ✓ ${result6.replaced ? '通过' : '失败'}: 跨 run 替换成功=${result6.replaced}`);
console.log('');

// 测试 7: 未找到文本
console.log('📝 测试 7: replaceTextInXmlRuns - 未找到文本');
const xml7 = '<w:r><w:t>Hello World</w:t></w:r>';
const result7 = replaceTextInXmlRuns(xml7, 'NotFound', 'Test');
console.log(`  输入: ${xml7}`);
console.log(`  替换 NotFound -> Test`);
console.log(`  ✓ ${!result7.replaced ? '通过' : '失败'}: 未找到时 replaced=false`);
console.log(`  ✓ ${result7.xml === xml7 ? '通过' : '失败'}: XML 未改变`);
console.log('');

// 测试 8: 版本号计算逻辑
console.log('📝 测试 8: 版本号计算逻辑 (模拟修复后的逻辑)');
const testVersionCases = [
    { input: undefined, expected: 1, desc: '空结果' },
    { input: 0, expected: 1, desc: '第0版' },
    { input: 5, expected: 6, desc: '第5版' },
    { input: '3', expected: 4, desc: '字符串3' },
];
for (const testCase of testVersionCases) {
    const nextVersionNo = testCase.input;
    const versionNo = Number(nextVersionNo || 0) + 1;
    const passed = versionNo === testCase.expected;
    console.log(`  ${testCase.desc}: 输入=${testCase.input}, 结果=v${versionNo}, 预期=v${testCase.expected} ${passed ? '✓' : '✗'}`);
}
console.log('');

console.log('='.repeat(60));
console.log('  所有测试完成！');
console.log('='.repeat(60));
