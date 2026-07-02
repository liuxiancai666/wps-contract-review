const normalizeChar = (char) => {
    const replacements = {
        '“': '"',
        '”': '"',
        '‘': "'",
        '’': "'",
        '：': ':',
        '，': ',',
        '。': '.',
    };
    return replacements[char] || char;
};

const normalizeForMatch = (text) => {
    const normalized = [];
    const indexMap = [];
    const source = String(text || '');
    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        if (/\s/.test(char)) continue;
        normalized.push(normalizeChar(char));
        indexMap.push(index);
    }
    return { value: normalized.join(''), indexMap };
};

const splitCandidates = (text) => {
    const value = String(text || '').trim();
    if (!value) return [];
    const parts = [value];
    const sentences = value
        .split(/(?<=[。！？；;.!?])\s*/g)
        .map((item) => item.trim())
        .filter((item) => item.length >= 8);
    parts.push(...sentences);
    if (value.length > 60) {
        parts.push(value.slice(0, 60), value.slice(-60));
    }
    if (value.length > 40) {
        parts.push(value.slice(0, 40), value.slice(-40));
    }
    const compact = value.replace(/\s+/g, '');
    if (compact !== value) parts.push(compact);
    return [...new Set(parts.filter((item) => item.length >= 6))];
};

const findTextRange = (contractText, targetText) => {
    const fullText = String(contractText || '');
    for (const candidate of splitCandidates(targetText)) {
        const exactIndex = fullText.indexOf(candidate);
        if (exactIndex >= 0) {
            return {
                start: exactIndex,
                end: exactIndex + candidate.length,
                text: fullText.slice(exactIndex, exactIndex + candidate.length),
            };
        }

        const normalizedFull = normalizeForMatch(fullText);
        const normalizedCandidate = normalizeForMatch(candidate).value;
        const normalizedIndex = normalizedFull.value.indexOf(normalizedCandidate);
        if (normalizedIndex >= 0) {
            const start = normalizedFull.indexMap[normalizedIndex];
            const end = normalizedFull.indexMap[normalizedIndex + normalizedCandidate.length - 1] + 1;
            return {
                start,
                end,
                text: fullText.slice(start, end),
            };
        }
    }
    return null;
};

const extractHeadings = (contractText) => {
    const lines = String(contractText || '').split(/\r?\n/);
    const headings = [];
    let cursor = 0;
    const chapterPattern = /^第[〇零一二两三四五六七八九十百千万亿\d]+章\s*.{0,40}$/;
    const clausePattern = /^第[〇零一二两三四五六七八九十百千万亿\d]+条\s*.{0,80}$/;

    for (const line of lines) {
        const trimmed = line.trim();
        if (chapterPattern.test(trimmed)) {
            headings.push({ type: 'section', text: trimmed, index: cursor + line.indexOf(trimmed) });
        } else if (clausePattern.test(trimmed)) {
            headings.push({ type: 'clause', text: trimmed, index: cursor + line.indexOf(trimmed) });
        }
        cursor += line.length + 1;
    }
    return headings;
};

const inferLocationContext = (contractText, start) => {
    const headings = extractHeadings(contractText).filter((heading) => heading.index <= start);
    const clause = [...headings].reverse().find((heading) => heading.type === 'clause');
    const section = [...headings].reverse().find((heading) => heading.type === 'section');
    return {
        clause_ref: clause?.text || '',
        section_title: section?.text || '',
    };
};

const enrichRiskLocations = (disputePoints = [], contractText = '') => (
    (Array.isArray(disputePoints) ? disputePoints : []).map((item) => {
        const originalClause = item?.original_clause || item?.original_text || '';
        const match = findTextRange(contractText, originalClause);
        if (!match) {
            return {
                ...item,
                location_verified: false,
            };
        }
        const context = inferLocationContext(contractText, match.start);
        return {
            ...item,
            clause_ref: item.clause_ref || context.clause_ref,
            section_title: item.section_title || context.section_title,
            location_start: match.start,
            location_end: match.end,
            location_text: match.text,
            location_verified: true,
        };
    })
);

module.exports = {
    enrichRiskLocations,
    findTextRange,
    inferLocationContext,
};
