const path = require('path');
const knex = require('knex')({
  client: 'sqlite3',
  connection: {
    filename: path.join(__dirname, 'database.sqlite'),
  },
  useNullAsDefault: true,
  pool: {
    afterCreate: (conn, cb) => {
      conn.run('PRAGMA journal_mode=WAL', cb);
    },
  },
});
module.exports = knex;
