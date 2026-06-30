/**
 * DOCX 批注插入服务 v4 — 修复归一化位置映射 bug
 *
 * 核心修复：searchPos 归一化匹配到位置后，映射回原始 displayText 中的位置
 *           确保 run 查找时的偏移正确
 */
const AdmZip = require('adm-zip');
const fs = require('fs');

const escapeXml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NS_DECL = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const COMMENT_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENT_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';

function parseRuns(bodyXml) {
  const runs = [];
  const re = /(<w:r[^>]*>[\s\S]*?<\/w:r>)/g;
  let m;
  while ((m = re.exec(bodyXml)) !== null) {
    const xml = m[1];
    const t = xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/);
    runs.push({ text: t ? t[1] : '', full: xml, start: m.index, end: m.lastIndex });
  }
  return { runs, displayText: runs.map(r => r.text).join('') };
}

/** 将归一化文本位置 N 映射回原始 displayText 中的字符位置 */
function normPosToRaw(displayText, normPos) {
  let nonWs = 0;
  for (let i = 0; i < displayText.length; i++) {
    if (/\s/.test(displayText[i])) continue;
    if (nonWs === normPos) return i;
    nonWs++;
  }
  return -1;
}

/** 在原始 displayText 中查找搜索文本，始终返回原始显示文本中的位置 */
function searchPos(displayText, searchText) {
  // 1. 精确匹配
  let p = displayText.indexOf(searchText);
  if (p >= 0) return p;
  // 2. 归一化匹配（去空白+全半角统一）
  const norm = s => String(s).replace(/\s+/g, '').replace(/[“”]/g, '"').replace(/[：]/g, ':').replace(/[，]/g, ',');
  const ndt = norm(displayText);
  const nst = norm(searchText);
  let np = ndt.indexOf(nst);
  if (np >= 0) return normPosToRaw(displayText, np);
  // 3. 按换行拆分，取第一段有效行匹配
  for (const line of searchText.split('\n')) {
    const t = line.trim();
    if (t.length > 3) {
      const nl = norm(t);
      np = ndt.indexOf(nl);
      if (np >= 0) return normPosToRaw(displayText, np);
    }
  }
  return -1;
}

/**
 * 在 DOCX 文件中插入批注 — 支持风险点/缺失条款/修改建议三种类型
 *
 * 每条批注需含:
 *   title        — 标题
 *   original_text — 在文档中查找定位的原文（缺失条款传空）
 *   body         — 批注正文（含类型标签）
 *   type         — 'risk' | 'missing' | 'suggestion'
 */
function insertReviewComments(docxPath, annotations, outputPath) {
  if (!fs.existsSync(docxPath)) throw new Error(`File not found: ${docxPath}`);
  if (!annotations || !annotations.length) return 0;

  const zip = new AdmZip(docxPath);
  const docXml = zip.getEntry('word/document.xml').getData().toString('utf8');
  const bm = docXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bm) throw new Error('No w:body in document.xml');
  const bodyXml = bm[1];

  const { runs, displayText } = parseRuns(bodyXml);

  let cid = 0;
  const xst = docXml.match(/w:id="(\d+)"/g);
  if (xst) cid = Math.max(...xst.map(s => parseInt(s.match(/\d+/)[0]))) + 1;

  const ins = [];

  for (const a of annotations) {
    if (!a.original_text) {
      // 无原文定位 → 回退插入（文档开头）
      ins.push({ cid: cid++, fallback: true,
        commentBody: a.body,
        author: 'AI审查', date: new Date().toISOString().replace(/T/,' ').replace(/\..+/,'') });
      continue;
    }
    const pos = searchPos(displayText, a.original_text);
    if (pos === -1) {
      // 未找到原文 → 回退
      ins.push({ cid: cid++, fallback: true,
        commentBody: a.body,
        author: 'AI审查', date: new Date().toISOString().replace(/T/,' ').replace(/\..+/,'') });
      continue;
    }
    let acc = 0, ri = -1, off = 0;
    for (let i = 0; i < runs.length; i++) {
      if (acc + runs[i].text.length > pos) { ri = i; off = pos - acc; break; }
      acc += runs[i].text.length;
    }
    if (ri === -1) {
      ins.push({ cid: cid++, fallback: true,
        commentBody: a.body,
        author: 'AI审查', date: new Date().toISOString().replace(/T/,' ').replace(/\..+/,'') });
      continue;
    }
    ins.push({ cid: cid++, runIdx: ri, runOffset: off,
      commentBody: a.body,
      author: 'AI审查', date: new Date().toISOString().replace(/T/,' ').replace(/\..+/,'') });
  }

  if (!ins.length) return 0;

  let newBody = bodyXml;
  for (const i of [...ins].reverse()) {
    if (i.fallback) {
      newBody = `<w:r><w:commentRangeStart w:id="${i.cid}"/><w:t xml:space="preserve"> </w:t></w:r>` +
        `<w:r><w:commentRangeEnd w:id="${i.cid}"/><w:commentReference w:id="${i.cid}"/></w:r>` + newBody;
      continue;
    }
    const r = runs[i.runIdx];
    if (!r) continue;
    const tm = r.full.match(/(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/);
    if (!tm) continue;
    const before = tm[2].slice(0, i.runOffset);
    const after  = tm[2].slice(i.runOffset);
    const replaced = tm[1] + before + tm[3] +
      `</w:r><w:r><w:commentRangeStart w:id="${i.cid}"/><w:t xml:space="preserve">${after}</w:t></w:r>` +
      `<w:r><w:commentRangeEnd w:id="${i.cid}"/><w:commentReference w:id="${i.cid}"/></w:r>`;
    newBody = newBody.slice(0, r.start) + replaced + newBody.slice(r.end);
  }

  zip.updateFile('word/document.xml', Buffer.from(docXml.replace(bm[0], `<w:body>${newBody}</w:body>`), 'utf8'));

  const ce = ins.map(i => `
    <w:comment w:id="${i.cid}" w:author="${escapeXml(i.author)}" w:date="${i.date}">
      <w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑"/><w:sz w:val="18"/><w:color w:val="FF0000"/></w:rPr>
      <w:t>${escapeXml(i.commentBody)}</w:t></w:r></w:p>
    </w:comment>`);
  const newCx = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments ${NS_DECL}>\n${ce.join('')}\n</w:comments>`;
  if (zip.getEntry('word/comments.xml')) zip.updateFile('word/comments.xml', Buffer.from(newCx, 'utf8'));
  else zip.addFile('word/comments.xml', Buffer.from(newCx, 'utf8'));

  const ct = zip.getEntry('[Content_Types].xml');
  if (ct) {
    let s = ct.getData().toString('utf8');
    if (!s.includes('comments.xml')) {
      s = s.replace('</Types>', `<Override PartName="/word/comments.xml" ContentType="${COMMENT_CT}"/>\n</Types>`);
      zip.updateFile('[Content_Types].xml', Buffer.from(s, 'utf8'));
    }
  }

  const rels = zip.getEntry('word/_rels/document.xml.rels');
  if (rels) {
    let s = rels.getData().toString('utf8');
    if (!s.includes('comments.xml')) {
      const mr = Math.max(...Array.from(s.matchAll(/Id="rId(\d+)"/g), m => parseInt(m[1])));
      s = s.replace('</Relationships>', `<Relationship Id="rId${mr+1}" Type="${COMMENT_REL_TYPE}" Target="comments.xml"/>\n</Relationships>`);
      zip.updateFile('word/_rels/document.xml.rels', Buffer.from(s, 'utf8'));
    }
  }

  zip.writeZip(outputPath || docxPath);
  return ins.length;
}

module.exports = { insertReviewComments };
