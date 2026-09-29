import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM. Output format: base64(iv).base64(tag).base64(ciphertext) */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload: string, keyHex: string): string {
  const key = parseKey(keyHex);
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('invalid ciphertext format');
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

function parseKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  return Buffer.from(keyHex, 'hex');
}
