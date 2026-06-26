const db = require('./database');

(async () => {
  console.log('=== KNOWLEDGE BASE ANALYSIS ===\n');

  // 1. Chunk size distribution
  const sizes = await db('vector_documents').select(db.raw('length(content) as csize'));
  if (!sizes.length) { console.log('No data'); return; }
  const vals = sizes.map(r => r.csize).sort((a,b)=>a-b);
  const sum = vals.reduce((a,b)=>a+b, 0);
  console.log('1. CHUNK SIZE DISTRIBUTION');
  console.log('   Count:', vals.length);
  console.log('   Min:', vals[0], 'Max:', vals[vals.length-1], 'Avg:', Math.round(sum/vals.length));
  console.log('   p25:', vals[Math.floor(vals.length*0.25)], 'p50:', vals[Math.floor(vals.length*0.5)], 'p75:', vals[Math.floor(vals.length*0.75)]);
  console.log('   Tiny (<30):', vals.filter(v=>v<30).length);
  console.log('   Huge (>800):', vals.filter(v=>v>800).length);

  // 2. By source type
  const byType = await db('vector_documents').select('source_type').count('* as cnt').groupBy('source_type').orderBy('cnt', 'desc');
  console.log('\n2. BY SOURCE TYPE');
  byType.forEach(r => console.log('   ' + r.source_type + ': ' + r.cnt));

  // 3. By category
  const byCat = await db('vector_documents').select('category', db.raw('count(*) as cnt')).groupBy('category').orderBy('cnt', 'desc').limit(15);
  console.log('\n3. TOP CATEGORIES');
  byCat.forEach(r => console.log('   ' + r.category.padEnd(25) + ' ' + r.cnt));

  // 4. Embedding quality check
  const samp = await db('vector_documents').limit(5).select('id', 'source_type', db.raw('length(embedding) as elen'));
  console.log('\n4. EMBEDDING QUALITY (sample)');
  samp.forEach(s => console.log('   id=' + s.id + ' type=' + s.source_type + ' embed_len=' + s.elen));

  // 5. Duplicate content check
  const dupHash = await db('vector_documents').select('content_hash').count('* as cnt').groupBy('content_hash').having('cnt', '>', 1).orderBy('cnt', 'desc').limit(5);
  console.log('\n5. DUPLICATE CONTENT');
  console.log('   Duplicate groups:', dupHash.length);
  dupHash.forEach(d => console.log('   count=' + d.cnt + ' hash=' + d.content_hash.slice(0,30)));

  // 6. Sample law content quality
  const lawSamp = await db('vector_documents').where('source_type', 'law').where('category', '合同编').limit(5).select('id', 'title', 'clause_id', db.raw('length(content) as clen'), 'content');
  console.log('\n6. SAMPLE LAW CHUNKS (合同编)');
  lawSamp.forEach(r => {
    console.log('   id=' + r.id + ' title=' + r.title + ' clause=' + r.clause_id + ' len=' + r.clen);
    console.log('   content: ' + r.content.slice(0, 200));
  });

  // 7. Check for FTS5 or indexes
  const tables = await db.raw("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log('\n7. ALL TABLES');
  console.log('   ' + tables.map(t=>t.name).join(', '));

  const idx = await db.raw("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name");
  console.log('\n8. INDEXES');
  console.log('   ' + (idx.length ? idx.map(t=>t.name).join(', ') : 'none'));

  // 9. Check if we're using hash vectors (value consistency check)
  const embedSample = await db('vector_documents').limit(3).select('embedding');
  console.log('\n9. EMBEDDING SAMPLE (first 10 values)');
  embedSample.forEach((r, i) => {
    const parsed = JSON.parse(r.embedding);
    console.log('   doc ' + i + ' first 10: ' + parsed.slice(0,10).map(v => v.toFixed(4)).join(', '));
  });

  console.log('\n=== DONE ===');
})();
