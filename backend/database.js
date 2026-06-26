const knex = require('knex')({
  client: 'pg',
  connection: {
    host: process.env.PG_HOST || '127.0.0.1',
    port: Number(process.env.PG_PORT || 5432),
    user: process.env.PG_USER || 'contract_review',
    password: process.env.PG_PASSWORD || 'contract_review',
    database: process.env.PG_DATABASE || 'contract_review',
  },
  pool: { min: 2, max: 10 },
});

module.exports = knex;
