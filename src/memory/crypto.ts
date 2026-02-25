import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { logger } from "../config/logger.js";

/**
 * AES-256-GCM encryption for sensitive memory values (credentials, passwords, tokens).
 *
 * Encrypted values are stored in the format: `enc:iv:authTag:ciphertext` (all hex).
 * This makes it easy to detect encrypted vs plaintext values — if a value starts with
 * "enc:", it needs decryption; otherwise it's legacy plaintext.
 *
 * The encryption key is derived from MEMORY_ENCRYPTION_KEY env var via scrypt (salt-based KDF).
 * If no key is configured, values are stored/returned as plaintext (graceful degradation).
 */

const ENCRYPTION_PREFIX = "enc:";
const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

// Derive a stable 256-bit key from the passphrase using scrypt with a fixed salt.
// The salt is fixed (not random) so the same passphrase always produces the same key.
// This is acceptable because the passphrase itself should have high entropy.
const FIXED_SALT = Buffer.from("rick-agent-memory-encryption-v1");

let derivedKey: Buffer | null = null;

function getKey(): Buffer | null {
  if (derivedKey) return derivedKey;

  const passphrase = process.env.MEMORY_ENCRYPTION_KEY;
  if (!passphrase) return null;

  derivedKey = scryptSync(passphrase, FIXED_SALT, KEY_LENGTH);
  return derivedKey;
}

/**
 * Categories whose values should be encrypted at rest.
 */
const SENSITIVE_CATEGORIES = new Set([
  "senhas",
  "credenciais",
  "tokens",
  "passwords",
  "secrets",
]);

/**
 * Check if a category should have its values encrypted.
 */
export function isSensitiveCategory(category: string): boolean {
  return SENSITIVE_CATEGORIES.has(category.toLowerCase());
}

/**
 * Encrypt a plaintext value. Returns the encrypted string in the format `enc:iv:authTag:ciphertext`.
 * If no encryption key is configured, returns the plaintext as-is.
 */
export function encryptValue(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;

  try {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

    const encrypted = Buffer.concat([
      cipher.update(plaintext, "utf-8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return `${ENCRYPTION_PREFIX}${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
  } catch (err) {
    logger.error({ err }, "Failed to encrypt value — storing as plaintext");
    return plaintext;
  }
}

/**
 * Decrypt an encrypted value. If the value is not encrypted (no `enc:` prefix), returns as-is.
 * If decryption fails (wrong key, corrupted data), returns the raw string with a warning.
 */
export function decryptValue(storedValue: string): string {
  if (!storedValue.startsWith(ENCRYPTION_PREFIX)) {
    // Plaintext (legacy or no encryption configured) — return as-is
    return storedValue;
  }

  const key = getKey();
  if (!key) {
    logger.warn("Encrypted value found but MEMORY_ENCRYPTION_KEY is not set — returning raw");
    return storedValue;
  }

  try {
    const parts = storedValue.slice(ENCRYPTION_PREFIX.length).split(":");
    if (parts.length !== 3) {
      logger.warn("Malformed encrypted value — returning raw");
      return storedValue;
    }

    const [ivHex, authTagHex, ciphertextHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(authTagHex, "hex");
    const ciphertext = Buffer.from(ciphertextHex, "hex");

    const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf-8");
  } catch (err) {
    logger.error({ err }, "Failed to decrypt value — wrong key or corrupted data");
    return storedValue;
  }
}

/**
 * Check if encryption is available (MEMORY_ENCRYPTION_KEY is configured).
 */
export function isEncryptionEnabled(): boolean {
  return !!getKey();
}
