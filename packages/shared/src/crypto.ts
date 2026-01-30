import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

/**
 * Get encryption key from environment or generate from password
 */
function getEncryptionKey(): Buffer {
  const envKey = process.env.ENCRYPTION_KEY;
  if (!envKey) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }

  // If key is 32 bytes (64 hex chars), use directly
  if (envKey.length === 64 && /^[a-f0-9]+$/i.test(envKey)) {
    return Buffer.from(envKey, 'hex');
  }

  // Otherwise, derive key from password using PBKDF2
  const salt = crypto.createHash('sha256').update('aramis-static-salt').digest();
  return crypto.pbkdf2Sync(envKey, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt a string value
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');

  const authTag = cipher.getAuthTag();

  // Format: iv:authTag:encrypted
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an encrypted string
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey();

  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid ciphertext format');
  }

  const [ivHex, authTagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * Encrypt OAuth tokens
 */
export function encryptTokens(tokens: {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
} {
  return {
    accessToken: encrypt(tokens.accessToken),
    refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : undefined,
    expiresAt: tokens.expiresAt,
  };
}

/**
 * Decrypt OAuth tokens
 */
export function decryptTokens(encryptedTokens: {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}): {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
} {
  return {
    accessToken: decrypt(encryptedTokens.accessToken),
    refreshToken: encryptedTokens.refreshToken
      ? decrypt(encryptedTokens.refreshToken)
      : undefined,
    expiresAt: encryptedTokens.expiresAt,
  };
}

/**
 * Hash a password using bcrypt-like approach with PBKDF2
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * Verify a password against a hash
 * Uses timing-safe comparison to prevent timing attacks
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const [saltHex, hashHex] = storedHash.split(':');

  if (!saltHex || !hashHex) {
    return false;
  }

  const salt = Buffer.from(saltHex, 'hex');
  const hash = crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

  const storedHashBuffer = Buffer.from(hashHex, 'hex');
  const computedHashBuffer = hash;

  // Use timing-safe comparison to prevent timing attacks
  if (storedHashBuffer.length !== computedHashBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(storedHashBuffer, computedHashBuffer);
}

/**
 * Generate a secure random token
 */
export function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Generate an API key
 */
export function generateApiKey(): string {
  // Format: aramis_sk_<random>
  const random = crypto.randomBytes(24).toString('base64url');
  return `aramis_sk_${random}`;
}

/**
 * Hash an API key for storage
 */
export function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}
