/**
 * Small key-value storage for the two features that need to keep something
 * on the server: encrypted sync copies and bill-reminder schedules.
 *
 * - On Netlify: Netlify Blobs (no setup needed).
 * - Locally / in tests: JSON files in BLOBS_DIR (or the system temp folder).
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const cache = new Map();

function fileStore(name) {
  const dir = path.join(process.env.BLOBS_DIR || path.join(os.tmpdir(), 'bloomfi-blobs'), name);
  const file = (key) => path.join(dir, `${encodeURIComponent(key)}.json`);
  return {
    async get(key) {
      try { return JSON.parse(await fs.readFile(file(key), 'utf8')); } catch { return null; }
    },
    async set(key, value) {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file(key)}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(value));
      await fs.rename(tmp, file(key));
    },
    async delete(key) { try { await fs.unlink(file(key)); } catch { /* already gone */ } },
    // Conditional write (only the local test server uses this one: a single process, so check-then-write is enough).
    async getVersioned(key) {
      try {
        const st = await fs.stat(file(key));
        return { value: JSON.parse(await fs.readFile(file(key), 'utf8')), tag: `${st.mtimeMs}:${st.size}` };
      } catch { return { value: null, tag: null }; }
    },
    async setVersioned(key, value, tag) {
      const cur = await this.getVersioned(key);
      if ((cur.tag || null) !== (tag || null)) return false;
      await this.set(key, value);
      return true;
    },
    async keys() {
      try { return (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).map((f) => decodeURIComponent(f.slice(0, -5))); } catch { return []; }
    },
  };
}

async function netlifyStore(name) {
  const { getStore } = await import('@netlify/blobs');
  const s = getStore({ name, consistency: 'strong' });
  return {
    get: (key) => s.get(key, { type: 'json' }),
    set: (key, value) => s.setJSON(key, value),
    delete: (key) => s.delete(key),
    async keys() { const { blobs } = await s.list(); return blobs.map((b) => b.key); },
    // Atomic compare-and-set with the blob's ETag: two devices saving at once can't overwrite each other.
    async getVersioned(key) {
      const r = await s.getWithMetadata(key, { type: 'json' });
      return r ? { value: r.data, tag: r.etag || null } : { value: null, tag: null };
    },
    async setVersioned(key, value, tag) {
      const r = await s.setJSON(key, value, tag ? { onlyIfMatch: tag } : { onlyIfNew: true });
      return r?.modified !== false;
    },
  };
}

export async function getKV(name) {
  if (cache.has(name)) return cache.get(name);
  let store;
  const onNetlify = !process.env.BLOBS_DIR && (process.env.NETLIFY_BLOBS_CONTEXT || globalThis.Netlify);
  if (onNetlify) {
    try { store = await netlifyStore(name); } catch (e) { console.error('[storage] Netlify Blobs unavailable, using temp files', e?.message); }
  }
  store ||= fileStore(name);
  cache.set(name, store);
  return store;
}

/** For tests: forget cached stores (e.g. after changing BLOBS_DIR). */
export function resetKV() { cache.clear(); }
