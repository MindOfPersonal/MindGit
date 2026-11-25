const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });

const mariadb = require('mariadb');

const pool = mariadb.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'github',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'github',
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
});

module.exports = pool;