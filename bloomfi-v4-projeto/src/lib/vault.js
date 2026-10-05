/**
 * Client-side encryption for BloomFi.
 *
 * A random 256-bit data key (DEK) encrypts every financial record with
 * AES-GCM. The DEK itself is stored only "wrapped" (encrypted):
 *   - by a key derived from the PIN (PBKDF2-SHA256, 600k iterations), and
 *   - optionally by a key from the device's biometrics (WebAuthn PRF).
 * A wrong PIN fails GCM authentication, so no PIN hash is ever stored.
 */
const subtle = crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();
export const PBKDF2_ITER = 600_000;

export const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export async function newDataKey() {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function kekFromPin(pin, salt, iterations = PBKDF2_ITER) {
  const base = await subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt']);
}

export async function kekFromSecret(secretBytes, salt) {
  const base = await subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('bloomfi-bio-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
}

export async function wrapKey(dek, kek) {
  const iv = rand(12);
  const ct = await subtle.wrapKey('raw', dek, kek, { name: 'AES-GCM', iv });
  return { iv, ct: new Uint8Array(ct) };
}

/** Throws when the KEK is wrong (e.g. wrong PIN). */
export async function unwrapKey(wrapped, kek) {
  return subtle.unwrapKey('raw', wrapped.ct, kek, { name: 'AES-GCM', iv: wrapped.iv }, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function encryptJSON(key, value) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return { iv, ct: new Uint8Array(ct) };
}

export async function decryptJSON(key, box) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: box.iv }, key, box.ct);
  return JSON.parse(dec.decode(pt));
}

// ---- password-protected backups (portable text) ----
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function chunkedB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function encryptBackup(data, password) {
  const salt = rand(16);
  const key = await kekFromPin(password, salt);
  const iv = rand(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(data))));
  return { app: 'BloomFi', encrypted: true, v: 1, iter: PBKDF2_ITER, salt: toB64(salt), iv: toB64(iv), ct: chunkedB64(ct) };
}

export async function decryptBackup(box, password) {
  const key = await kekFromPin(password, fromB64(box.salt), box.iter || PBKDF2_ITER);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.ct));
  return JSON.parse(dec.decode(pt));
}
