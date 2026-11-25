import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '../../../..');

function flag(value) {
  return String(value ?? '').toLowerCase() === 'true';
}

/**
 * Tally settings come from the server only. A request never supplies the
 * company, the host or the import directory (docs/m3-books-plan.md §6, §9).
 */
export function tallyConfig(env = process.env) {
  return {
    enabled: flag(env.TALLY_ENABLED),
    host: (env.TALLY_HOST || '').trim(),
    company: (env.TALLY_COMPANY || env.SHOP_LEGAL_NAME || 'Annachi Kadai Co').trim(),
    shopStateCode: String(env.SHOP_STATE_CODE || '33').trim(),
    allowPrivateHost: flag(env.TALLY_ALLOW_PRIVATE_HOST),
    importDir: env.TALLY_IMPORT_DIR || resolve(rootDir, 'var/imports'),
    timeoutMs: Number(env.TALLY_TIMEOUT_MS || 10_000),
    maxResponseBytes: Number(env.TALLY_MAX_RESPONSE_BYTES || 1_048_576),
    maxUploadBytes: Number(env.TALLY_MAX_UPLOAD_BYTES || 10 * 1024 * 1024),
  };
}
