const db = require('./database');
const { ensureVectorStore } = require('./services/vectorStore');

async function ensureColumn(tableName, columnName, addColumn) {
  const exists = await db.schema.hasColumn(tableName, columnName);
  if (!exists) {
    console.log(`[DB Init] Adding ${tableName}.${columnName}...`);
    await db.schema.table(tableName, addColumn);
  }
}

async function resetAndRebuildDatabase() {
  console.log('[DB Init] Starting database schema verification and rebuild...');
  try {
    const hasUsersTable = await db.schema.hasTable('users');
    if (!hasUsersTable) {
        console.log('[DB Init] Creating new `users` table...');
        await db.schema.createTable('users', (table) => {
            table.increments('id').primary();
            table.string('fingerprint_id').unique();
            table.string('username').unique();
            table.string('password_hash');
            table.string('role').defaultTo('user');
            table.timestamps(true, true);
        });
        console.log('[DB Init] New `users` table created successfully.');
    } else {
      // 添加新列（如果不存在）
      await ensureColumn('users', 'username', (table) => table.string('username').unique());
      await ensureColumn('users', 'password_hash', (table) => table.string('password_hash'));
      await ensureColumn('users', 'role', (table) => table.string('role').defaultTo('user'));
      // fingerprint_id 改为可空（已有唯一索引不需要改）
    }

    const hasContractsTable = await db.schema.hasTable('contracts');
    
    if (hasContractsTable) {
      // Table already exists, so we do nothing.
      // The logic in database.js will handle any necessary column additions.
      console.log('[DB Init] `contracts` table already exists. Skipping creation.');
    } else {
      // Only create the table if it does not exist.
      console.log('[DB Init] Creating new `contracts` table with the latest schema...');
      await db.schema.createTable('contracts', (table) => {
        table.increments('id').primary();
        table.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE');
        table.string('original_filename').notNullable();
        table.string('storage_path').notNullable();
        table.string('document_key').unique();
        table.string('perspective'); // To store the user's review perspective (e.g., '甲方')
        table.text('analysis_result'); // To store the JSON result from the AI analysis
        table.text('pre_analysis_data'); // To store the full payload from the pre-analysis/setup step
        table.string('status'); // To track the contract's state (e.g., 'Uploaded', 'Reviewed')
        table.text('pre_analysis_cache'); // Add column to cache pre-analysis results
        table.timestamps(true, true);
      });
      console.log('[DB Init] New `contracts` table created successfully. Schema is now up-to-date.');
    }

    await ensureColumn('contracts', 'analysis_partial_result', (table) => table.text('analysis_partial_result'));
    await ensureColumn('contracts', 'analysis_status', (table) => table.string('analysis_status'));
    await ensureColumn('contracts', 'group_id', (table) => table.integer('group_id').unsigned());
    await ensureColumn('contracts', 'edit_enabled', (table) => table.boolean('edit_enabled').defaultTo(true));
    // 确保默认值始终为 true（ensureColumn 只在列不存在时生效，列已存在时需单独修改默认值）
    await db.raw("ALTER TABLE contracts ALTER COLUMN edit_enabled SET DEFAULT true").catch(() => {});

    const hasContractVersionsTable = await db.schema.hasTable('contract_versions');
    if (!hasContractVersionsTable) {
      console.log('[DB Init] Creating new `contract_versions` table...');
      await db.schema.createTable('contract_versions', (table) => {
        table.increments('id').primary();
        table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
        table.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
        table.integer('version_no').notNullable();
        table.string('source_action').notNullable();
        table.string('storage_path');
        table.text('plain_text');
        table.timestamps(true, true);
        table.index(['contract_id', 'version_no']);
      });
    }

    const hasContractGroupsTable = await db.schema.hasTable('contract_groups');
    if (!hasContractGroupsTable) {
      console.log('[DB Init] Creating new `contract_groups` table...');
      await db.schema.createTable('contract_groups', (table) => {
        table.increments('id').primary();
        table.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE');
        table.string('name').notNullable();
        table.text('analysis_result');
        table.string('status');
        table.timestamps(true, true);
      });
    }
    await ensureColumn('contract_groups', 'analysis_result', (table) => table.text('analysis_result'));
    await ensureColumn('contract_groups', 'status', (table) => table.string('status'));

    const hasQaHistoryTable = await db.schema.hasTable('qa_history');
    if (!hasQaHistoryTable) {
        console.log('[DB Init] Creating new `qa_history` table...');
        await db.schema.createTable('qa_history', (table) => {
            table.increments('id').primary();
            table.string('session_id').notNullable().index();
            table.string('role').notNullable();
            table.text('content').notNullable();
            table.integer('contract_id').unsigned().references('id').inTable('contracts').onDelete('SET NULL');
            table.timestamps(true, true);
        });
        console.log('[DB Init] New `qa_history` table created successfully.');
    }

    const hasFocusedReviewsTable = await db.schema.hasTable('focused_reviews');
    if (!hasFocusedReviewsTable) {
        console.log('[DB Init] Creating new `focused_reviews` table...');
        await db.schema.createTable('focused_reviews', (table) => {
            table.increments('id').primary();
            table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
            table.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
            table.text('source_text').notNullable();
            table.string('question');
            table.string('perspective');
            table.string('contract_type');
            table.string('template_id');
            table.text('result').notNullable(); // JSON string of the focused review result
            table.timestamps(true, true);
            table.index(['contract_id', 'created_at']);
        });
        console.log('[DB Init] New `focused_reviews` table created successfully.');
    }

    // review_comments 表 — 批注交互（同意/不同意/文字批注）
    const hasReviewCommentsTable = await db.schema.hasTable('review_comments');
    if (!hasReviewCommentsTable) {
        console.log('[DB Init] Creating new `review_comments` table...');
        await db.schema.createTable('review_comments', (table) => {
            table.increments('id').primary();
            table.integer('contract_id').unsigned().notNullable().references('id').inTable('contracts').onDelete('CASCADE');
            table.integer('user_id').unsigned().references('id').inTable('users').onDelete('SET NULL');
            table.string('item_type').notNullable();  // 'dispute_point' | 'missing_clause' | 'suggestion' | 'breach_cost' | 'party_review'
            table.integer('item_index').notNullable(); // 该类型数组中的索引
            table.string('action_type').notNullable(); // 'agree' | 'disagree' | 'comment'
            table.text('comment_text');                 // 文字批注内容（仅 comment 时必填）
            table.boolean('is_resolved').defaultTo(false);
            table.timestamps(true, true);
            table.index(['contract_id', 'item_type', 'item_index']);
        });
        console.log('[DB Init] New `review_comments` table created successfully.');
    } else {
        // 列迁移：确保 action_type 列存在（旧表可能缺少此列）
        const cols = await db.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'review_comments'`);
        const existingCols = new Set(cols.rows.map(r => r.column_name));
        if (!existingCols.has('action_type')) {
            console.log('[DB Init] Adding action_type column to review_comments...');
            await db.schema.raw("ALTER TABLE review_comments ADD COLUMN action_type VARCHAR NOT NULL DEFAULT 'comment'");
        }
        if (!existingCols.has('is_resolved')) {
            console.log('[DB Init] Adding is_resolved column to review_comments...');
            await db.schema.raw("ALTER TABLE review_comments ADD COLUMN is_resolved BOOLEAN DEFAULT false");
        }
    }

    const hasReviewRulesTable = await db.schema.hasTable('review_rules');
    if (!hasReviewRulesTable) {
        console.log('[DB Init] Creating new `review_rules` table...');
        await db.schema.createTable('review_rules', (table) => {
            table.increments('id').primary();
            table.integer('user_id').unsigned().references('id').inTable('users').onDelete('CASCADE');
            table.string('name').notNullable();
            table.string('contract_type_keywords').defaultTo('');
            table.text('review_points').defaultTo('[]'); // JSON array of strings
            table.text('core_purposes').defaultTo('[]'); // JSON array of strings
            table.text('prompt_rules').defaultTo('[]');  // JSON array of strings
            table.boolean('is_enabled').defaultTo(true);
            table.timestamps(true, true);
            table.index('user_id');
            table.index('name');
        });
        console.log('[DB Init] New `review_rules` table created successfully.');
    }

    await ensureVectorStore();
    console.log('[DB Init] Vector store tables created. Vector index will be built from the knowledge base page.');

  } catch (error) {
    console.error("[DB Init] FATAL: Failed to rebuild database schema:", error);
    process.exit(1); // Exit if we can't build the database
  }
}

// Rename the exported function for clarity
module.exports = resetAndRebuildDatabase; 
