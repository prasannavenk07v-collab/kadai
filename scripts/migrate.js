import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolve(__dirname, '..');

// Load .env
const envPath = resolve(rootDir, '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const [key, ...rest] = trimmed.split('=');
      const val = rest.join('=').trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key.trim()]) {
        process.env[key.trim()] = val;
      }
    }
  }
}

const connectionString = process.env.DATABASE_URL || 'postgres://kadai:kadai@localhost:5432/kadai';

const dbDir = resolve(rootDir, 'src/server/db');
const migrationsDir = join(dbDir, 'migrations');

// schema.sql is the initial shape; every file in migrations/ is replayed after
// it in filename order. All statements are additive and idempotent, so the
// whole set can run against a restored backup or an already-migrated database.
function migrationFiles() {
  const files = [{ label: 'src/server/db/schema.sql', path: join(dbDir, 'schema.sql') }];
  if (existsSync(migrationsDir)) {
    for (const name of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
      files.push({ label: `src/server/db/migrations/${name}`, path: join(migrationsDir, name) });
    }
  }
  return files;
}

async function migrate() {
  console.log(`🔌 Connecting to database: ${connectionString.replace(/:[^:@]+@/, ':***@')}`);
  const client = new pg.Client({
    connectionString,
    ssl: connectionString.includes('supabase.co') ? { rejectUnauthorized: false } : false,
  });

  try {
    await client.connect();
    console.log('✅ Connected.');

    await client.query('BEGIN');
    for (const file of migrationFiles()) {
      console.log(`📜 Executing ${file.label}...`);
      await client.query(readFileSync(file.path, 'utf8'));
    }
    await client.query('COMMIT');

    console.log('🎉 Migration successful! All tables, enums and constraints created.');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    console.error('❌ Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

migrate();
