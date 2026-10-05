/**
 * BloomFi local database (IndexedDB on the user's own device).
 *
 * When the user turns on the PIN, every financial record is encrypted with
 * AES-256-GCM before it touches the disk (see lib/vault.js). Only small
 * settings needed before unlocking (language, PIN length, subscription
 * token) stay in plain text in the "meta" store.
 */
import { openDB } from 'idb';
import {
  newDataKey, kekFromPin, kekFromSecret, wrapKey, unwrapKey, encryptJSON, decryptJSON, rand, PBKDF2_ITER,
} from './lib/vault.js';

const DB_NAME = 'bloomfi';
const DB_VERSION = 4;
export const STORES = ['transactions', 'budgets', 'goals', 'chat', 'assets', 'connections', 'accounts', 'cards', 'categories'];
// Encrypted like the data, but never exported or synced (e.g. the sync key).
const ALL_STORES = [...STORES, 'secrets'];

let dbPromise;
export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 1) {
          const tx = db.createObjectStore('transactions', { keyPath: 'id' });
          tx.createIndex('date', 'date');
          db.createObjectStore('budgets', { keyPath: 'id' });
          db.createObjectStore('goals', { keyPath: 'id' });
          db.createObjectStore('chat', { keyPath: 'id' });
          db.createObjectStore('meta');
        }
        if (oldVersion < 2) {
          db.createObjectStore('assets', { keyPath: 'id' });
          db.createObjectStore('connections', { keyPath: 'id' });
        }
        if (oldVersion < 3) {
          db.createObjectStore('accounts', { keyPath: 'id' });
          db.createObjectStore('cards', { keyPath: 'id' });
        }
        if (oldVersion < 4) {
          db.createObjectStore('categories', { keyPath: 'id' });
          db.createObjectStore('secrets', { keyPath: 'id' });
        }
      },
      blocking() { dbPromise?.then((d) => d.close()); dbPromise = null; },
    });
  }
  return dbPromise;
}

// ---------------- encryption state ----------------
let dek = null; // data key, only in memory while unlocked
let vaultMeta = null;

class LockedError extends Error { constructor() { super('locked'); this.code = 'locked'; } }

async function encode(value) {
  if (!vaultMeta) return value;
  if (!dek) throw new LockedError();
  const box = await encryptJSON(dek, value);
  return { id: value.id, _iv: box.iv, _ct: box.ct };
}

async function decode(rec) {
  if (!rec || !rec._ct) return rec;
  if (!dek) throw new LockedError();
  return decryptJSON(dek, { iv: rec._iv, ct: rec._ct });
}

async function rewriteAll(transform) {
  const d = await getDB();
  for (const s of ALL_STORES) {
    const rows = await d.getAll(s);
    const out = [];
    for (const r of rows) out.push(await transform(r));
    const tx = d.transaction(s, 'readwrite');
    await Promise.all([...out.map((v) => tx.store.put(v)), tx.done]);
  }
}

export const vault = {
  async load() { vaultMeta = (await (await getDB()).get('meta', 'vault')) || null; return vaultMeta; },
  get enabled() { return !!vaultMeta; },
  get unlocked() { return !vaultMeta || !!dek; },
  get pinLength() { return vaultMeta?.pinLength || 6; },
  get hasBio() { return !!vaultMeta?.bio; },
  get bioInfo() { return vaultMeta?.bio ? { credId: vaultMeta.bio.credId, prfSalt: vaultMeta.bio.prfSalt } : null; },

  async create(pin) {
    const key = await newDataKey();
    const salt = rand(16);
    const meta = { v: 1, salt, iter: PBKDF2_ITER, pin: await wrapKey(key, await kekFromPin(pin, salt)), pinLength: String(pin).length, bio: null, createdAt: Date.now() };
    // Decode with the old state (plain), then encrypt with the new key.
    const plain = async (r) => decode(r);
    const d = await getDB();
    const snapshot = {};
    for (const s of ALL_STORES) { snapshot[s] = []; for (const r of await d.getAll(s)) snapshot[s].push(await plain(r)); }
    dek = key;
    vaultMeta = meta;
    await d.put('meta', meta, 'vault');
    for (const s of ALL_STORES) {
      const tx = d.transaction(s, 'readwrite');
      const enc = [];
      for (const v of snapshot[s]) enc.push(await encode(v));
      await Promise.all([...enc.map((v) => tx.store.put(v)), tx.done]);
    }
  },

  async unlock(pin) {
    if (!vaultMeta) await this.load();
    if (!vaultMeta) return true;
    try {
      dek = await unwrapKey(vaultMeta.pin, await kekFromPin(pin, vaultMeta.salt, vaultMeta.iter));
      return true;
    } catch {
      return false;
    }
  },

  async unlockWithSecret(secret) {
    if (!vaultMeta?.bio) return false;
    try {
      dek = await unwrapKey(vaultMeta.bio.wrapped, await kekFromSecret(secret, vaultMeta.bio.prfSalt));
      return true;
    } catch {
      return false;
    }
  },

  lock() { if (vaultMeta) dek = null; },

  async changePin(newPin) {
    if (!vaultMeta || !dek) throw new LockedError();
    const salt = rand(16);
    vaultMeta = { ...vaultMeta, salt, iter: PBKDF2_ITER, pin: await wrapKey(dek, await kekFromPin(newPin, salt)), pinLength: String(newPin).length };
    await (await getDB()).put('meta', vaultMeta, 'vault');
  },

  async enableBio({ credId, prfSalt, secret }) {
    if (!vaultMeta || !dek) throw new LockedError();
    vaultMeta = { ...vaultMeta, bio: { credId, prfSalt, wrapped: await wrapKey(dek, await kekFromSecret(secret, prfSalt)) } };
    await (await getDB()).put('meta', vaultMeta, 'vault');
  },

  async disableBio() {
    if (!vaultMeta) return;
    vaultMeta = { ...vaultMeta, bio: null };
    await (await getDB()).put('meta', vaultMeta, 'vault');
  },

  /** Turns encryption off: every record is written back in plain text. */
  async disable() {
    if (!vaultMeta) return;
    if (!dek) throw new LockedError();
    await rewriteAll(decode);
    await (await getDB()).delete('meta', 'vault');
    vaultMeta = null;
    dek = null;
  },
};

// ---------------- data access ----------------
export const db = {
  async get(store, id) { return decode(await (await getDB()).get(store, id)); },
  async all(store) {
    const rows = await (await getDB()).getAll(store);
    const out = [];
    for (const r of rows) out.push(await decode(r));
    return out;
  },
  /** touch=false keeps the record's updatedAt (used when applying synced data). */
  async put(store, value, { touch = true } = {}) {
    return (await getDB()).put(store, await encode(touch ? { ...value, updatedAt: Date.now() } : value));
  },
  async putMany(store, values, { touch = true } = {}) {
    if (!values.length) return;
    const encoded = [];
    const t = Date.now();
    for (const v of values) encoded.push(await encode(touch ? { ...v, updatedAt: t } : v));
    const tx = (await getDB()).transaction(store, 'readwrite');
    await Promise.all([...encoded.map((v) => tx.store.put(v)), tx.done]);
  },
  /** Deletions are remembered for a while so other synced devices delete the record too. */
  async remove(store, id, { tomb = true } = {}) {
    const d = await getDB();
    if (tomb && store !== 'chat') {
      const tombs = (await d.get('meta', 'tombstones')) || {};
      tombs[`${store}:${id}`] = Date.now();
      await d.put('meta', tombs, 'tombstones');
    }
    return d.delete(store, id);
  },
  async getTombstones() {
    const tombs = (await (await getDB()).get('meta', 'tombstones')) || {};
    const limit = Date.now() - 180 * 86400000;
    return Object.fromEntries(Object.entries(tombs).filter(([, ts]) => ts > limit));
  },
  async setTombstones(tombs) { return (await getDB()).put('meta', tombs, 'tombstones'); },
  /** Brings records back to life (undo, restore): forget that they were deleted. */
  async dropTombstones(store, ids) {
    const d = await getDB();
    const tombs = (await d.get('meta', 'tombstones')) || {};
    let n = 0;
    for (const id of ids) if (delete tombs[`${store}:${id}`]) n++;
    if (n) await d.put('meta', tombs, 'tombstones');
  },
  async getSecret(id) { return decode(await (await getDB()).get('secrets', id)); },
  async putSecret(id, value) { return (await getDB()).put('secrets', await encode({ ...value, id })); },
  async delSecret(id) { return (await getDB()).delete('secrets', id); },
  async clear(store) { return (await getDB()).clear(store); },
  async getMeta(key) { return (await getDB()).get('meta', key); },
  async setMeta(key, value) { return (await getDB()).put('meta', value, key); },
  async delMeta(key) { return (await getDB()).delete('meta', key); },

  /** Plain JSON of everything (requires unlocked). */
  async exportAll() {
    const out = { app: 'BloomFi', version: 3, exportedAt: new Date().toISOString() };
    for (const s of STORES) out[s] = await this.all(s);
    const settings = await this.getMeta('settings');
    out.settings = settings ? { ...settings, pinHash: undefined } : null;
    out.account = (await this.getMeta('account')) || null;
    return out;
  },

  /**
   * Restores a backup. The backup becomes the current version of the data: restored records
   * count as changed now, and records it doesn't have count as deleted now, so devices that
   * sync agree with it instead of bringing the old state back.
   */
  async importAll(data) {
    if (!data || data.app !== 'BloomFi') throw new Error('invalid-backup');
    const d = await getDB();
    const now = Date.now();
    const tombs = (await d.get('meta', 'tombstones')) || {};
    for (const s of STORES) {
      const list = data[s] || [];
      if (s !== 'chat') {
        const keep = new Set(list.map((v) => v.id));
        for (const id of await d.getAllKeys(s)) if (!keep.has(id)) tombs[`${s}:${id}`] = now;
        for (const id of keep) delete tombs[`${s}:${id}`];
      }
      const rows = [];
      for (const v of list) rows.push(await encode(s === 'chat' ? v : { ...v, updatedAt: now }));
      const tx = d.transaction(s, 'readwrite');
      await tx.store.clear();
      await Promise.all([...rows.map((v) => tx.store.put(v)), tx.done]);
    }
    await d.put('meta', tombs, 'tombstones');
    const current = (await d.get('meta', 'settings')) || {};
    if (data.settings) await d.put('meta', { ...current, ...data.settings, pinHash: undefined, onboarded: true, settingsAt: now }, 'settings');
    if (data.account?.token) await d.put('meta', data.account, 'account');
  },

  async wipe() {
    const d = await getDB();
    const tx = d.transaction([...ALL_STORES, 'meta'], 'readwrite');
    for (const s of [...ALL_STORES, 'meta']) await tx.objectStore(s).clear();
    await tx.done;
    dek = null;
    vaultMeta = null;
  },
};

/** Ask the browser to never evict our data (important on phones). */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage?.persist) return await navigator.storage.persist();
  } catch { /* ignore */ }
  return false;
}

export async function storageInfo() {
  try {
    const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : false;
    const est = navigator.storage?.estimate ? await navigator.storage.estimate() : {};
    return { persisted, usage: est.usage || 0, quota: est.quota || 0 };
  } catch {
    return { persisted: false, usage: 0, quota: 0 };
  }
}

// Keep several open windows/tabs (e.g. on a PC) in sync.
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('bloomfi-sync') : null;
export const sync = {
  notify(kind = 'changed') { channel?.postMessage(kind); },
  listen(fn) {
    if (!channel) return () => {};
    const h = (e) => fn(e.data);
    channel.addEventListener('message', h);
    return () => channel.removeEventListener('message', h);
  },
};
