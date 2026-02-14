import crypto from 'crypto';
import os from 'os';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

let keyWarningShown = false;

function getEncryptionKey(): Buffer {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (key && key.length >= 32) {
    return Buffer.from(key.slice(0, 32), 'utf-8');
  }

  // No explicit key configured — derive one from machine identity so that
  // stored tokens are at least unique per host. Log a clear warning on first
  // use so operators know to set a proper key for production.
  if (!keyWarningShown) {
    keyWarningShown = true;
    console.warn(
      '[Security] DATA_ENCRYPTION_KEY is not set or too short (need >=32 chars). ' +
      'Using a machine-derived fallback. Set a strong DATA_ENCRYPTION_KEY in your .env for production.'
    );
  }

  // Derive from hostname + platform — not truly secret but unique per machine
  const seed = `prevue:${os.hostname()}:${os.platform()}:${os.arch()}`;
  return crypto.createHash('sha256').update(seed).digest();
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
