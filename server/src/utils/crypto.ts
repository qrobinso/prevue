import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

let cachedKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const key = process.env.DATA_ENCRYPTION_KEY;
  if (key && key.length >= 32) {
    cachedKey = Buffer.from(key.slice(0, 32), 'utf-8');
    return cachedKey;
  }

  // No explicit key configured — use a persisted random key in the data
  // directory so it survives Docker container restarts (the data dir is
  // mounted as a volume).
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, '../../../data');
  const keyFile = path.join(dataDir, '.encryption-key');

  try {
    if (fs.existsSync(keyFile)) {
      const stored = fs.readFileSync(keyFile, 'utf-8').trim();
      if (stored.length >= 64) {
        cachedKey = Buffer.from(stored, 'hex');
        return cachedKey;
      }
    }
  } catch {
    // Key file unreadable — regenerate below
  }

  // Generate and persist a new random key
  console.warn(
    '[Security] DATA_ENCRYPTION_KEY is not set. Generating a persistent key in the data directory. ' +
    'Set DATA_ENCRYPTION_KEY in your .env for explicit control.'
  );

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, generated.toString('hex'), { mode: 0o600 });
  cachedKey = generated;
  return cachedKey;
}

export function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

export function decrypt(encrypted: string): string {
  const key = getEncryptionKey();
  const parts = encrypted.split(':');

  if (parts.length !== 3) {
    // Not encrypted, return as-is (migration support)
    return encrypted;
  }

  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encryptedText = parts[2];

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Generate SHA-256 hash for schedule seed
 */
export function generateSeed(channelId: number, blockStartISO: string): string {
  return crypto.createHash('sha256')
    .update(`${channelId}${blockStartISO}`)
    .digest('hex');
}
