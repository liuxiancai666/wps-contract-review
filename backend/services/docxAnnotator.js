/**
 * DOCX 批注插入服务 - 直接操作底层 XML
 * 
 * DOCX 本质是 ZIP, 内含 word/document.xml (正文) + word/comments.xml (批注)
 * 此服务直接在 XML 层插入批注，绕过任何 JSAPI 代理
 */
const AdmZip = require('adm-zip');
const fs = require('fs');
const path = require('path');

const escapeXml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NS_DECL = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const COMMENT_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENT_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';

/**
 * 在 DOCX 文件中为每个修改建议插入 WPS 标准的批注 (comment)
 * @param {string} docxPath - DOCX 文件路径
 * @param {Array} suggestions - [{ title, original_text, suggested_text, reason, plain_language }]
 * @param {string} outputPath - 输出路径（默认覆盖源文件）
 * @returns {number} 成功插入数
 */
function insertReviewComments(docxPath, suggestions, outputPath) {
  if (!fs.existsSync(docxPath)) throw new Error(`File not found: ${docxPath}`);
  if (!suggestions || !suggestions.length) return 0;

  const zip = new AdmZip(docxPath);
  const docXml = zip.getEntry('word/document.xml').getData().toString('utf8');
  const bodyMatch = docXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bodyMatch) throw new Error('No w:body found in document.xml');
  const bodyXml = bodyMatch[1];

  // 1. 提取所有 <w:t> 文本片段的准确位置
  const runs = [];
  const tRe = /(<w:r[^>]*>[\s\S]*?<\/w:r>)/g;
  let m;
  while ((m = tRe.exec(bodyXml)) !== null) runs.push({ full: m[1], start: m.index, end: m.lastIndex });

  // 提取每个 run 内的文本
  const runTexts = runs.map(r => {
    const t = r.full.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/);
    return { text: t ? t[1] : '', runIdx: 0, ...r };
  });

  // 构建全文用于搜索
  const fullText = runTexts.map(r => r.text).join('');
  const norm = s => s.replace(/\s+/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[：：]/g, ':').replace(/[，,]/g, ',');

  let commentId = 0;
  const existing = docXml.match(/<w:comment[^>]*w:id="(\d+)"/g);
  if (existing) {
    const ids = existing.map(e => parseInt(e.match(/w:id="(\d+)"/)[1]));
    commentId = Math.max(...ids) + 1;
  }

  const inserted = [];

  for (const s of suggestions) {
    if (!s.original_text) continue;
    const search = norm(s.original_text);
    const pos = norm(fullText).indexOf(search);
    if (pos === -1) continue;

    // 计算这个位置落在哪个 run
    let charAcc = 0;
    let startRi = -1, startOff = 0;
    for (let i = 0; i < runTexts.length; i++) {
      const len = runTexts[i].text.length;
      if (charAcc + len > pos) { startRi = i; startOff = pos - charAcc; break; }
      charAcc += len;
    }
    if (startRi === -1) continue;

    // 批注内容
    const commentBody = `【AI审查】${s.title || '修改建议'}\n建议：${s.suggested_text || ''}\n理由：${s.reason || ''}`;
    const cid = commentId++;
    const author = 'AI审查';
    const date = new Date().toISOString().replace(/T/, ' ').replace(/\..+/, '');

    inserted.push({
      cid, commentBody, author, date,
      runIdx: startRi, runOffset: startOff,
    });
  }

  if (!inserted.length) return 0;

  // 2. 从后往前修改 document.xml 中的 runs，插入批注标记
  let newBodyXml = bodyXml;
  for (const ins of inserted.reverse()) {
    const ri = ins.runIdx;
    const run = runs[ri];
    const tMatch = run.full.match(/(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/);
    if (!tMatch) continue;

    const openTag = tMatch[1];
    const textContent = tMatch[2];
    const closeTag = tMatch[3];

    const before = textContent.slice(0, ins.runOffset);
    const after = textContent.slice(ins.runOffset);

    // 拆分为: 前半文本 + 批注起始 + 后半文本 + 批注结束 + 引用
    const newContent = `${before}</w:t></w:r><w:r><w:commentRangeStart w:id="${ins.cid}"/><w:t>${after}</w:t></w:r><w:r><w:commentRangeEnd w:id="${ins.cid}"/><w:commentReference w:id="${ins.cid}"/></w:r>`;

    // 注意：这里不改变 run.start/end 索引，因为我们从后往前替换，之前索引不受影响
    const oldStr = run.full;
    const replacer = oldStr.replace(/(<w:t[^>]*>)[\s\S]*?(<\/w:t>)/, `$1${before}$2</w:r><w:r><w:commentRangeStart w:id="${ins.cid}"/><w:t>${after}</w:t></w:r><w:r><w:commentRangeEnd w:id="${ins.cid}"/><w:commentReference w:id="${ins.cid}"/>`);
    newBodyXml = newBodyXml.substring(0, run.start) + replacer + newBodyXml.substring(run.end);
  }

  // 3. 拼回完整 document.xml
  const newDocXml = docXml.replace(bodyMatch[0], `<w:body>${newBodyXml}</w:body>`);
  zip.updateEntry('word/document.xml', Buffer.from(newDocXml, 'utf8'));

  // 4. 构建/更新 comments.xml
  const commentEntries = inserted.map(ins => `
    <w:comment w:id="${ins.cid}" w:author="${escapeXml(ins.author)}" w:date="${ins.date}">
      <w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>
        <w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑"/><w:sz w:val="18"/><w:color w:val="FF0000"/></w:rPr>
          <w:t>${escapeXml(ins.commentBody)}</w:t></w:r>
      </w:p>
    </w:comment>`);

  const newCommentsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:comments ${NS_DECL}>
${commentEntries.join('')}
</w:comments>`;

  if (zip.getEntry('word/comments.xml')) {
    zip.updateEntry('word/comments.xml', Buffer.from(newCommentsXml, 'utf8'));
  } else {
    zip.addFile('word/comments.xml', Buffer.from(newCommentsXml, 'utf8'));
  }

  // 5. 确保 [Content_Types].xml 和 _rels 包含批注
  const ctEntry = zip.getEntry('[Content_Types].xml');
  if (ctEntry) {
    let ctXml = ctEntry.getData().toString('utf8');
    if (!ctXml.includes('comments.xml')) {
      ctXml = ctXml.replace('</Types>', `<Override PartName="/word/comments.xml" ContentType="${COMMENT_CT}"/>\n</Types>`);
      zip.updateEntry('[Content_Types].xml', Buffer.from(ctXml, 'utf8'));
    }
  }

  const relsEntry = zip.getEntry('word/_rels/document.xml.rels');
  if (relsEntry) {
    let relsXml = relsEntry.getData().toString('utf8');
    if (!relsXml.includes('comments.xml')) {
      const maxRid = [...relsXml.matchAll(/Id="rId(\d+)"/g)].map(m => parseInt(m[1])).reduce((a, b) => Math.max(a, b), 0);
      relsXml = relsXml.replace('</Relationships>', `<Relationship Id="rId${maxRid + 1}" Type="${COMMENT_REL_TYPE}" Target="comments.xml"/>\n</Relationships>`);
      zip.updateEntry('word/_rels/document.xml.rels', Buffer.from(relsXml, 'utf8'));
    }
  }

  const outPath = outputPath || docxPath;
  zip.writeZip(outPath);
  return inserted.length;
}

module.exports = { insertReviewComments };
