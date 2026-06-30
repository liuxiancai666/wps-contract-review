/**
 * DOCX 批注插入服务 v3 — 直接操作底层 XML
 *
 * 高效：一次性扫描 body XML → run 列表 → 匹配原文 → 反向插入
 */
const AdmZip = require('adm-zip');
const fs = require('fs');

const escapeXml = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NS_DECL = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const COMMENT_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments';
const COMMENT_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml';

/**
 * 从 bodyXml 提取所有 run，每个 run 带 text + start/end offset + full XML
 */
function parseRuns(bodyXml) {
  const runs = [];
  const re = /(<w:r[^>]*>[\s\S]*?<\/w:r>)/g;
  let m;
  while ((m = re.exec(bodyXml)) !== null) {
    const xml = m[1];
    const t = xml.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/);
    runs.push({ text: t ? t[1] : '', full: xml, start: m.index, end: m.lastIndex });
  }
  const displayText = runs.map(r => r.text).join('');
  return { runs, displayText };
}

/** 归一化：去空白 */
const n = s => String(s).replace(/\s+/g, '');

/** 查找位置：精确→归一化→按行拆分 */
function searchPos(displayText, searchText) {
  const dt = displayText;
  let p = dt.indexOf(searchText);
  if (p >= 0) return p;
  const ndt = n(dt);
  const nst = n(searchText);
  p = ndt.indexOf(nst);
  if (p >= 0) return p;
  // 换行分割
  for (const line of searchText.split('\n')) {
    const t = line.trim();
    if (t.length > 3) {
      p = ndt.indexOf(n(t));
      if (p >= 0) return p;
    }
  }
  return -1;
}

function insertReviewComments(docxPath, suggestions, outputPath) {
  if (!fs.existsSync(docxPath)) throw new Error(`File not found: ${docxPath}`);
  if (!suggestions || !suggestions.length) return 0;

  const zip = new AdmZip(docxPath);
  const docXml = zip.getEntry('word/document.xml').getData().toString('utf8');
  const bm = docXml.match(/<w:body>([\s\S]*?)<\/w:body>/);
  if (!bm) throw new Error('No w:body in document.xml');
  const bodyXml = bm[1];

  const { runs, displayText } = parseRuns(bodyXml);

  // 最大已有批注 ID
  let cid = 0;
  const xst = docXml.match(/w:id="(\d+)"/g);
  if (xst) cid = Math.max(...xst.map(s => parseInt(s.match(/\d+/)[0]))) + 1;

  const ins = [];

  for (const s of suggestions) {
    if (!s.original_text) continue;
    const pos = searchPos(displayText, s.original_text);
    if (pos === -1) {
      ins.push({ cid: cid++, fallback: true,
        commentBody: `【AI审查】${s.title||'修改建议'}\n建议：${s.suggested_text||''}\n理由：${s.reason||''}`,
        author: 'AI审查', date: new Date().toISOString().replace(/T/,' ').replace(/\..+/,'') });
      continue;
    }
    let acc = 0, ri = -1, off = 0;
    for (let i = 0; i < runs.length; i++) {
      if (acc + runs[i].text.length > pos) { ri = i; off = pos - acc; break; }
      acc += runs[i].text.length;
    }
    if (ri === -1) continue;
    ins.push({ cid: cid++, runIdx: ri, runOffset: off,
      commentBody: `【AI审查】${s.title||'修改建议'}\n建议：${s.suggested_text||''}\n理由：${s.reason||''}`,
      author: 'AI审查', date: new Date().toISOString().replace(/T/,' ').replace(/\..+/,'') });
  }

  if (!ins.length) return 0;

  // 反向替换 bodyXml
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

  // 写 document.xml
  zip.updateFile('word/document.xml', Buffer.from(docXml.replace(bm[0], `<w:body>${newBody}</w:body>`), 'utf8'));

  // comments.xml
  const ce = ins.map(i => `
    <w:comment w:id="${i.cid}" w:author="${escapeXml(i.author)}" w:date="${i.date}">
      <w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>
      <w:r><w:rPr><w:rFonts w:ascii="微软雅黑" w:hAnsi="微软雅黑"/><w:sz w:val="18"/><w:color w:val="FF0000"/></w:rPr>
      <w:t>${escapeXml(i.commentBody)}</w:t></w:r></w:p>
    </w:comment>`);
  const newCx = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments ${NS_DECL}>\n${ce.join('')}\n</w:comments>`;
  if (zip.getEntry('word/comments.xml')) zip.updateFile('word/comments.xml', Buffer.from(newCx, 'utf8'));
  else zip.addFile('word/comments.xml', Buffer.from(newCx, 'utf8'));

  // [Content_Types].xml
  const ct = zip.getEntry('[Content_Types].xml');
  if (ct) {
    let s = ct.getData().toString('utf8');
    if (!s.includes('comments.xml')) {
      s = s.replace('</Types>', `<Override PartName="/word/comments.xml" ContentType="${COMMENT_CT}"/>\n</Types>`);
      zip.updateFile('[Content_Types].xml', Buffer.from(s, 'utf8'));
    }
  }

  // rels
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
