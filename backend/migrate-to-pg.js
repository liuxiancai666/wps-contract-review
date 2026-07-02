const path = require('path');
const knexPg = require('knex')({
  client: 'pg',
  connection: {
    host: '127.0.0.1',
    port: 5432,
    user: 'contract_review',
    password: 'contract_review',
    database: 'contract_review',
  },
  pool: { min: 2, max: 10 },
});

const knexSqlite = require('knex')({
  client: 'sqlite3',
  connection: { filename: path.join(__dirname, 'database.sqlite') },
  useNullAsDefault: true,
});

async function migrate() {
  console.log('Creating PostgreSQL tables...');

  // Users
  await knexPg.schema.createTable('users', (t) => {
    t.increments('id').primary();
    t.string('fingerprint_id', 255).notNullable();
    t.datetime('created_at').notNullable().defaultTo(knexPg.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knexPg.fn.now());
  });

  // Contract groups
  await knexPg.schema.createTable('contract_groups', (t) => {
    t.increments('id').primary();
    t.integer('user_id');
    t.string('name', 255).notNullable();
    t.text('analysis_result');
    t.string('status', 255);
    t.datetime('created_at').notNullable().defaultTo(knexPg.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knexPg.fn.now());
  });

  // Contracts
  await knexPg.schema.createTable('contracts', (t) => {
    t.increments('id').primary();
    t.integer('user_id');
    t.string('original_filename', 255).notNullable();
    t.string('storage_path', 255).notNullable();
    t.string('document_key', 255);
    t.string('perspective', 255);
    t.text('analysis_result');
    t.text('pre_analysis_data');
    t.string('status', 255);
    t.text('pre_analysis_cache');
    t.datetime('created_at').notNullable().defaultTo(knexPg.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knexPg.fn.now());
    t.text('analysis_partial_result');
    t.string('analysis_status', 255);
    t.integer('group_id');
  });

  // Contract versions
  await knexPg.schema.createTable('contract_versions', (t) => {
    t.increments('id').primary();
    t.integer('contract_id').notNullable();
    t.integer('user_id');
    t.integer('version_no').notNullable();
    t.string('source_action', 255).notNullable();
    t.string('storage_path', 255);
    t.text('plain_text');
    t.datetime('created_at').notNullable().defaultTo(knexPg.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knexPg.fn.now());
  });

  // Focused reviews
  await knexPg.schema.createTable('focused_reviews', (t) => {
    t.increments('id').primary();
    t.integer('contract_id').notNullable();
    t.integer('user_id');
    t.text('source_text').notNullable();
    t.string('question', 255);
    t.string('perspective', 255);
    t.string('contract_type', 255);
    t.string('template_id', 255);
    t.text('result').notNullable();
    t.datetime('created_at').notNullable().defaultTo(knexPg.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knexPg.fn.now());
  });

  // QA history
  await knexPg.schema.createTable('qa_history', (t) => {
    t.increments('id').primary();
    t.string('session_id', 255).notNullable();
    t.string('role', 255).notNullable();
    t.text('content').notNullable();
    t.integer('contract_id');
    t.datetime('created_at').notNullable().defaultTo(knexPg.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knexPg.fn.now());
  });

  // Vector documents (keep as text for SQLite compatibility; Milvus is the real vector store)
  await knexPg.schema.createTable('vector_documents', (t) => {
    t.increments('id').primary();
    t.string('source_type', 255).notNullable().index();
    t.string('source_id', 255).notNullable().unique();
    t.string('title', 255).notNullable();
    t.string('category', 255);
    t.string('clause_id', 255);
    t.string('source_name', 255);
    t.string('source_url', 255);
    t.integer('chunk_index').defaultTo(0);
    t.string('content_hash', 255).index();
    t.text('content').notNullable();
    t.text('metadata');
    t.text('embedding').notNullable();
    t.datetime('created_at').notNullable().defaultTo(knexPg.fn.now());
    t.datetime('updated_at').notNullable().defaultTo(knexPg.fn.now());
  });

  console.log('Tables created. Migrating data...');

  const tables = ['users', 'contract_groups', 'contracts', 'contract_versions', 'focused_reviews', 'qa_history', 'vector_documents'];

  for (const table of tables) {
    const rows = await knexSqlite(table).select('*');
    if (rows.length > 0) {
      await knexPg(table).insert(rows);
      console.log(`  ${table}: ${rows.length} rows migrated`);
    } else {
      console.log(`  ${table}: 0 rows (empty)`);
    }
  }

  // Fix sequences
  for (const table of tables) {
    const maxId = await knexPg(table).max('id as max').first();
    if (maxId && maxId.max) {
      await knexPg.raw(`SELECT setval('${table}_id_seq', ${maxId.max})`);
      console.log(`  ${table}_id_seq set to ${maxId.max}`);
    }
  }

  console.log('\nMigration complete!');
  await knexPg.destroy();
  await knexSqlite.destroy();
}

migrate().catch((e) => { console.error('Migration failed:', e); process.exit(1); });
