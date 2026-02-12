import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey(): Buffer {
  const key = process.env.DATA_ENCRYPTION_KEY;
  if (key && key.length >= 32) {
    return Buffer.from(key.slice(0, 32), 'utf-8');
  }
  // Fallback: derive a key from a stable machine identifier
  // This is less secure but allows the app to work without explicit config
  const fallback = 'prevue-default-key-change-me-pls!';
  return Buffer.from(fallback, 'utf-8');
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
