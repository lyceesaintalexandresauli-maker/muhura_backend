require('dotenv').config();
const { Pool } = require('pg');

const readEnv = (key) => String(process.env[key] || '').trim();

const parseSslMode = () => {
  const explicit = readEnv('DB_SSL') || readEnv('PGSSLMODE');
  if (explicit) {
    const normalized = explicit.toLowerCase();
    if (['false', '0', 'disable', 'off', 'no'].includes(normalized)) {
      return false;
    }
    if (['true', '1', 'require', 'prefer', 'on', 'yes'].includes(normalized)) {
      return { rejectUnauthorized: false };
    }
  }

  const connectionString = readEnv('DATABASE_URL');
  if (/sslmode=require/i.test(connectionString) || /supabase\.com/i.test(connectionString)) {
    return { rejectUnauthorized: false };
  }

  const host = readEnv('DB_HOST');
  if (/supabase\.com/i.test(host)) {
    return { rejectUnauthorized: false };
  }

  return false;
};

const buildPoolConfig = () => {
  const connectionString = readEnv('DATABASE_URL');
  const ssl = parseSslMode();

  if (connectionString) {
    return {
      connectionString,
      ssl,
    };
  }

  return {
    user: readEnv('DB_USER') || undefined,
    host: readEnv('DB_HOST') || undefined,
    database: readEnv('DB_NAME') || undefined,
    password: readEnv('DB_PASSWORD') || undefined,
    port: readEnv('DB_PORT') ? Number(readEnv('DB_PORT')) : undefined,
    ssl,
  };
};

const pool = new Pool(buildPoolConfig());

pool.on('error', (err) => {
  console.error('Unexpected PostgreSQL pool error:', err);
});

pool.connect()
  .then((client) => {
    client.release();
    console.log('Connected to the database successfully!');
  })
  .catch((err) => console.error('Database connection error:', err));

module.exports = pool;
