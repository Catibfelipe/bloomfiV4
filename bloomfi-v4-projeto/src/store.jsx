import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { db, vault, sync, requestPersistence } from './db.js';
import { pendingRecurring } from './lib/finance.js';
import { setCustomCategories } from './lib/categories.js';
import {
  readLocal, writeLocal, mergeSnapshots, sameSnapshot, snapshotHash, deriveSyncKey, newSalt, exportKey, importKey, sealSnapshot, openSnapshot, saltOf,
} from './lib/sync.js';
import {
  enableReminders, disableReminders, currentSubscription, buildReminders, sendSchedule, sendTest, localReminder, pushSupported,
} from './lib/push.js';
import { makeMoney, uid, round2 } from './lib/format.js';
import {
  DEFAULT_ACCOUNT_ID, defaultAccount, buildInstallments, invoiceForPayment, accountBalance, totals, agenda,
} from './lib/ledger.js';
import { currentMonth, monthKey, todayISO, addDays, toISO } from './lib/dates.js';
import { makeT } from './i18n.js';
import { sampleData } from './lib/sample.js';
import { registerBiometric, biometricSecret } from './lib/biometric.js';
import { encryptBackup, decryptBackup } from './lib/vault.js';
import {
  api, loadServerConfig, verifyLicense, computeEntitlement, takeCheckoutReturn, IS_ARTIFACT,
} from './lib/billing.js';
import { openConnect, fetchItemData, deleteItem, mapItemData, demoItemData } from './lib/openfinance.js';

const Ctx = createContext(null);
export const useStore = () => useContext(Ctx);

const browserLang = () => ((navigator.language || 'pt').toLowerCase().startsWith('pt') ? 'pt' : 'en');
export const defaultSettings = () => {
  const lang = browserLang();
  return {
    name: '', lang, currency: lang === 'pt' ? 'BRL' : 'USD', onboarded: false, pinHash: null, dismissed: {},
    autoLockMin: 5, hideValues: false, textSize: 'normal', reminders: { enabled: false, hour: 9, detail: false },
  };
};

/** Legacy (v2) PIN check, only used once to migrate to the encrypted vault. */
async function legacyHash(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`bloomfi:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const EMPTY = { txs: [], budgets: [], goals: [], chat: [], assets: [], connections: [], accounts: [], cards: [], categories: [] };
const LOAD_ORDER = ['transactions', 'budgets', 'goals', 'chat', 'assets', 'connections', 'accounts', 'cards', 'categories'];
const clampDay = (d, fb) => Math.min(Math.max(Math.round(Number(d)) || fb, 1), 31);

/**
 * Records the app creates by itself (a recurring month, a bank movement) get the same id on every
 * device and updatedAt 0: if the user deleted one anywhere, the deletion wins over the copy
 * another device creates later.
 */
const autoRecord = (r) => ({ ...r, updatedAt: 0 });
const notDeleted = (tombs, store = 'transactions') => (r) => !tombs[`${store}:${r.id}`];
function hashId(text) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}
/** Same imported movement -> same id on every device, so two devices importing it never duplicate it. */
export const importedId = (importId) => `imp_${hashId(String(importId))}`;
const MAX_TRIES = 5;

export function StoreProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [settings, setSettings] = useState(defaultSettings);
  const [data, setDataRaw] = useState(EMPTY);
  // Async actions (and "Undo" buttons) always read and update the latest data, never a stale copy.
  const dataRef = useRef(EMPTY);
  dataRef.current = data;
  const setData = useCallback((v) => setDataRaw((d) => {
    const n = typeof v === 'function' ? v(d) : v;
    dataRef.current = n;
    return n;
  }), []);
  const [locked, setLocked] = useState(false);
  const [vaultInfo, setVaultInfo] = useState({ enabled: false, bio: false, pinLength: 6 });
  const [month, setMonth] = useState(currentMonth());
  const [toastMsg, setToastMsg] = useState(null);
  const [txModal, setTxModal] = useState(null);
  const [serverCfg, setServerCfg] = useState(null);
  const [license, setLicense] = useState(null); // { token, payload, checkedAt }
  const [account, setAccount] = useState(null); // { token, email }
  const [trialStart, setTrialStart] = useState(null);
  const [tick, setTick] = useState(0);
  const [guard, setGuard] = useState({ fails: 0, until: 0 });
  const [syncing, setSyncing] = useState(null);
  const [cloud, setCloud] = useState({ enabled: false, status: 'idle', lastSyncAt: null, error: null });
  const cloudBusy = useRef(null);
  const cloudTimer = useRef(null);
  const licenseRef = useRef(null);
  const toastTimer = useRef();
  const lastActive = useRef(Date.now());
  const hiddenAt = useRef(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  /** action = { label, run } shows a button in the toast (e.g. "Desfazer"). */
  const toast = useCallback((text, kind = 'ok', action = null) => {
    clearTimeout(toastTimer.current);
    setToastMsg({ text, kind, id: Date.now(), action });
    toastTimer.current = setTimeout(() => setToastMsg(null), action ? 7000 : 3200);
  }, []);
  const dismissToast = useCallback(() => { clearTimeout(toastTimer.current); setToastMsg(null); }, []);

  const refreshVaultInfo = () => setVaultInfo({ enabled: vault.enabled, bio: vault.hasBio, pinLength: vault.pinLength });

  const loadData = useCallback(async () => {
    if (!vault.unlocked) return false;
    const [t, b, g, c, a, cn, ac, cd, cats] = await Promise.all(LOAD_ORDER.map((s) => db.all(s)));
    let txs = t;
    let accounts = ac;
    if (!accounts.some((x) => x.id === DEFAULT_ACCOUNT_ID)) {
      // Every user has at least one account: the one all older transactions belong to.
      const st = (await db.getMeta('settings')) || {};
      const main = defaultAccount(makeT(st.lang || browserLang())('acc.defaultName'));
      await db.put('accounts', main);
      accounts = [main, ...accounts];
    }
    // v3 -> v4: bank movements imported before accounts existed belong to an unknown bank account,
    // so they must not change the main account balance.
    const legacy = txs.filter((x) => x.source === 'openfinance' && !x.accountId && !x.cardId);
    if (legacy.length) {
      const fixed = new Map(legacy.map((x) => [x.id, { ...x, accountId: 'of:legacy' }]));
      await db.putMany('transactions', [...fixed.values()]);
      txs = txs.map((x) => fixed.get(x.id) || x);
    }
    // Automatic recurring items whose first date has arrived are confirmed (e.g. the salary set up at onboarding).
    const today = todayISO();
    const due = txs.filter((x) => ((x.recurring && !x.recurringOf) || x.autoConfirm) && x.status === 'pending' && x.autoPay !== false && x.date <= today);
    if (due.length) {
      const done = new Map(due.map((x) => [x.id, { ...x, status: 'paid' }]));
      await db.putMany('transactions', [...done.values()]);
      txs = txs.map((x) => done.get(x.id) || x);
    }
    // A month the user deleted (on any device) is not created again.
    const gen = pendingRecurring(txs).filter(notDeleted(await db.getTombstones())).map(autoRecord);
    if (gen.length) { await db.putMany('transactions', gen, { touch: false }); txs = [...txs, ...gen]; }
    setData({ txs, budgets: b, goals: g, chat: c.sort((x, y) => x.at - y.at), assets: a, connections: cn, accounts, cards: cd, categories: cats });
    return true;
  }, []);

  const loadSettings = useCallback(async () => {
    const s = await db.getMeta('settings');
    const st = { ...defaultSettings(), ...(s || {}) };
    setSettings(st);
    return st;
  }, []);

  // ---------- boot ----------
  useEffect(() => {
    (async () => {
      const st = await loadSettings();
      await vault.load();
      refreshVaultInfo();
      setGuard((await db.getMeta('pinGuard')) || { fails: 0, until: 0 });
      const needsPin = vault.enabled || !!st.pinHash;
      setLocked(needsPin);
      if (!needsPin) await loadData();
      setAccount((await db.getMeta('account')) || null);
      setTrialStart((await db.getMeta('trialStart')) ?? null);
      const lic = await db.getMeta('license');
      if (lic) setLicense(lic);
      setReady(true);
      // Server config arrives later; the app is usable meanwhile.
      const cfg = await loadServerConfig();
      setServerCfg(cfg);
    })().catch((e) => { console.error(e); setReady('error'); });
  }, [loadData, loadSettings]);

  // other tabs/windows
  useEffect(() => sync.listen(async (kind) => {
    await loadSettings();
    await vault.load();
    refreshVaultInfo();
    if (kind === 'lock' || (vault.enabled && !vault.unlocked)) { vault.lock(); setData(EMPTY); setLocked(true); return; }
    setAccount((await db.getMeta('account')) || null);
    setLicense((await db.getMeta('license')) || null);
    await loadData();
  }), [loadData, loadSettings]);

  useEffect(() => { document.documentElement.lang = settings.lang === 'pt' ? 'pt-BR' : 'en'; }, [settings.lang]);
  // Bigger text for people who need it (everything scales together, layout included).
  useEffect(() => {
    const z = { normal: 1, large: 1.12, xlarge: 1.25 }[settings.textSize] || 1;
    document.body.style.zoom = z === 1 ? '' : String(z);
  }, [settings.textSize]);


  // After any change: tell other tabs, and send it to the user's other devices a few seconds later.
  const changed = () => { sync.notify(); scheduleCloud(); };
  function scheduleCloud(ms = 4000) {
    clearTimeout(cloudTimer.current);
    cloudTimer.current = setTimeout(() => { runCloudRef.current?.(); }, ms);
  }
  const runCloudRef = useRef(null);

  // ---------- lock / auto-lock ----------
  const lock = useCallback((broadcast = true) => {
    if (!vault.enabled) return;
    vault.lock();
    setData(EMPTY);
    setTxModal(null);
    setLocked(true);
    if (broadcast) sync.notify('lock');
  }, []);

  useEffect(() => {
    if (!vaultInfo.enabled || locked) return undefined;
    const bump = () => { lastActive.current = Date.now(); };
    const limitMs = () => {
      const m = Number(settingsRef.current.autoLockMin);
      return m < 0 ? Infinity : m * 60000;
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        if (Number(settingsRef.current.autoLockMin) === 0) lock();
      } else {
        if (hiddenAt.current && Date.now() - hiddenAt.current > limitMs()) lock();
        hiddenAt.current = null;
        bump();
        loadData();
      }
    };
    const timer = setInterval(() => { if (Date.now() - lastActive.current > Math.max(limitMs(), 60000)) lock(); }, 15000);
    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => window.addEventListener(ev, bump, { passive: true }));
    document.addEventListener('visibilitychange', onVis);
    bump();
    return () => {
      clearInterval(timer);
      ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach((ev) => window.removeEventListener(ev, bump));
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [vaultInfo.enabled, locked, lock, loadData]);

  // Unlocked without PIN: refresh data when coming back to the app
  useEffect(() => {
    if (vaultInfo.enabled) return undefined;
    const onVis = () => { if (document.visibilityState === 'visible') loadData(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [vaultInfo.enabled, loadData]);

  // ---------- subscription ----------
  const [licPayload, setLicPayload] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const p = license?.token && serverCfg?.licensePublicJwk ? await verifyLicense(license.token, serverCfg.licensePublicJwk) : null;
      if (alive) setLicPayload(p);
    })();
    return () => { alive = false; };
  }, [license, serverCfg]);

  // Trial starts the first time this device sees the paid version.
  useEffect(() => {
    if (serverCfg?.billing?.enabled && trialStart == null && ready) {
      const t0 = Date.now();
      setTrialStart(t0);
      db.setMeta('trialStart', t0);
    }
  }, [serverCfg, trialStart, ready]);

  useEffect(() => { const id = setInterval(() => setTick((n) => n + 1), 60000); return () => clearInterval(id); }, []);

  const entitlement = useMemo(
    () => computeEntitlement({ cfg: serverCfg, license: licPayload, trialStart, hadAccount: !!account }),
    [serverCfg, licPayload, trialStart, account, tick], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const saveLicense = useCallback(async (token) => {
    const rec = token ? { token, checkedAt: Date.now() } : null;
    if (rec) await db.setMeta('license', rec); else await db.delMeta('license');
    setLicense(rec);
  }, []);

  const saveAccount = useCallback(async (acc) => {
    if (acc?.token) await db.setMeta('account', acc); else await db.delMeta('account');
    setAccount(acc?.token ? acc : null);
  }, []);

  const refreshLicense = useCallback(async ({ force = false } = {}) => {
    if (!account?.token || !serverCfg?.billing?.enabled) return null;
    const age = Date.now() - (license?.checkedAt || 0);
    const left = licPayload ? licPayload.exp * 1000 - Date.now() : 0;
    if (!force && age < 12 * 3600000 && left > 20 * 86400000) return null;
    try {
      const r = await api('license', { method: 'POST', body: { accountToken: account.token } });
      await saveLicense(r.license || null);
      changed();
      return r;
    } catch (e) {
      if (e.code === 'invalid_account') await saveAccount(null);
      return null;
    }
  }, [account, serverCfg, license, licPayload, saveLicense, saveAccount]);

  useEffect(() => { if (ready && serverCfg) refreshLicense(); }, [ready, serverCfg, account]); // eslint-disable-line react-hooks/exhaustive-deps

  // Coming back from Stripe Checkout
  useEffect(() => {
    if (!ready || !serverCfg?.billing?.enabled) return;
    const ret = takeCheckoutReturn();
    if (!ret) return;
    const t = makeT(settingsRef.current.lang);
    if (ret.state === 'cancel') { toast(t('bill.canceled'), 'info'); return; }
    if (ret.state === 'success' && ret.sessionId) {
      (async () => {
        try {
          const r = await api('billing/claim', { method: 'POST', body: { sessionId: ret.sessionId } });
          await saveAccount({ token: r.accountToken, email: r.email });
          await saveLicense(r.license);
          toast(t('bill.welcome'));
          changed();
        } catch {
          toast(t('bill.claimErr'), 'err');
        }
      })();
    }
  }, [ready, serverCfg]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- sync between devices ----------
  licenseRef.current = license;
  const cloudDirty = useRef(false);
  const cloudStop = useRef(false);
  async function runCloud({ first = null, manual = false } = {}) {
    if (cloudBusy.current) {
      // Something changed while a sync was running: sync again right after it.
      cloudDirty.current = true;
      return manual ? cloudBusy.current : null;
    }
    cloudDirty.current = false;
    const job = (async () => {
      const meta = await db.getMeta('sync');
      if (cloudStop.current || !meta?.enabled || !vault.unlocked) return null;
      const token = licenseRef.current?.token;
      if (!token) { setCloud((c) => ({ ...c, enabled: true, status: 'error', error: 'subscription_required' })); return null; }
      // A device that joined existing data keeps its choice (use the cloud copy / join both) until that first sync works.
      const mode = first || meta.pendingFirst || null;
      setCloud((c) => ({ ...c, enabled: true, status: 'syncing', error: null }));
      try {
        const key = await importKey((await db.getSecret('syncKey')).raw);
        // Nothing changed here nor in the cloud since the last sync: no need to download it all.
        if (!mode && meta.lastHash && meta.version) {
          const head = await api('sync?meta=1', { token });
          if (head.version === meta.version && (await snapshotHash(await readLocal(db, settingsRef.current))) === meta.lastHash) {
            const at = Date.now();
            const cur = await db.getMeta('sync');
            if (!cur?.enabled || cloudStop.current) return null;
            await db.setMeta('sync', { ...cur, lastSyncAt: at });
            setCloud({ enabled: true, status: 'ok', lastSyncAt: at, error: null });
            return { ok: true, changed: false };
          }
        }
        let changedHere = false;
        let version = meta.version || 0;
        let hash = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          const remote = await api('sync', { token, timeout: 60000 });
          if (cloudStop.current) return null;
          if ((meta.version || 0) > (remote.version || 0)) {
            // The cloud copy was deleted (on another device): stop here instead of uploading this device's data again.
            await db.delMeta('sync');
            await db.delSecret('syncKey');
            setCloud({ enabled: false, status: 'idle', lastSyncAt: null, error: 'cloud_deleted' });
            if (manual) throw Object.assign(new Error('cloud_deleted'), { code: 'cloud_deleted', handled: true });
            return null;
          }
          const remoteSnap = remote.data ? await openSnapshot(remote.data, key) : null;
          const replace = mode === 'replace' && !!remoteSnap;
          const local = await readLocal(db, settingsRef.current, { includeSample: replace });
          const merged = replace ? { ...remoteSnap, at: Date.now() } : mergeSnapshots(local, remoteSnap, { preferRemote: mode === 'merge' });
          if (await writeLocal(db, merged, local)) changedHere = true;
          // Name, language and currency follow the newest change (or the cloud, when joining it).
          const rs = merged.settings || {};
          const cur = settingsRef.current;
          if (rs.at && (rs.at !== (cur.settingsAt || 0) || ['name', 'lang', 'currency'].some((k) => rs[k] != null && rs[k] !== cur[k]))) {
            const next = { ...cur, name: rs.name ?? cur.name, lang: rs.lang || cur.lang, currency: rs.currency || cur.currency, settingsAt: rs.at };
            settingsRef.current = next;
            setSettings(next);
            await db.setMeta('settings', next);
          }
          version = remote.version;
          if (!remoteSnap || !sameSnapshot(merged, remoteSnap)) {
            try {
              version = (await api('sync', { method: 'PUT', token, timeout: 60000, body: { baseVersion: remote.version, data: await sealSnapshot(merged, key, meta.salt) } })).version;
            } catch (e) {
              if (e.status === 409) continue; // another device synced meanwhile: merge again
              throw e;
            }
          }
          hash = await snapshotHash(merged);
          break;
        }
        const at = Date.now();
        // Sync may have been turned off meanwhile: never switch it back on.
        const cur = await db.getMeta('sync');
        if (!cur?.enabled || cloudStop.current) return null;
        await db.setMeta('sync', { ...cur, version, lastSyncAt: at, lastHash: hash, pendingFirst: undefined });
        if (changedHere) { await loadData(); sync.notify(); }
        setCloud({ enabled: true, status: 'ok', lastSyncAt: at, error: null });
        return { ok: true, changed: changedHere };
      } catch (e) {
        if (!e.handled) setCloud((c) => ({ ...c, status: 'error', error: e.code || 'generic' }));
        if (manual || first) throw e;
        return null;
      }
    })();
    cloudBusy.current = job;
    try {
      return await job;
    } finally {
      cloudBusy.current = null;
      if (cloudDirty.current && !cloudStop.current) { cloudDirty.current = false; scheduleCloud(1500); }
    }
  }
  runCloudRef.current = () => runCloud().catch(() => {});
  /** Stops syncing on this device: waits for a sync in progress to finish first. */
  async function stopCloud() {
    cloudStop.current = true;
    clearTimeout(cloudTimer.current);
    try { await cloudBusy.current; } catch { /* already reported */ }
  }

  useEffect(() => {
    (async () => {
      const meta = await db.getMeta('sync');
      if (meta?.enabled) setCloud((c) => ({ ...c, enabled: true, lastSyncAt: meta.lastSyncAt || null }));
    })();
  }, [ready]);
  // Sync when the app opens (unlocked, with a subscription), every 5 minutes and when coming back to it.
  useEffect(() => {
    if (!ready || locked || !cloud.enabled || !license?.token) return undefined;
    runCloudRef.current();
    const id = setInterval(() => document.visibilityState === 'visible' && runCloudRef.current(), 5 * 60000);
    const onVis = () => { if (document.visibilityState === 'visible') scheduleCloud(500); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, [ready, locked, cloud.enabled, license?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- data helpers ----------
  const setPart = (key, fn) => setData((d) => ({ ...d, [key]: typeof fn === 'function' ? fn(d[key]) : fn }));

  const actions = useMemo(() => { const tr = makeT(settingsRef.current.lang); const D = () => dataRef.current; const A = {
    async updateSettings(patch) {
      const synced = ['name', 'lang', 'currency'].some((k) => k in patch && patch[k] !== settingsRef.current[k]);
      const next = { ...settingsRef.current, ...patch, ...(synced ? { settingsAt: Date.now() } : {}) };
      setSettings(next);
      await db.setMeta('settings', next);
      changed();
    },

    /**
     * Saves one transaction. A new card purchase with `installments` > 1 becomes N monthly parcels.
     * Types: expense | income | invest | redeem | transfer (transfer to a card = paying its invoice).
     */
    async saveTx(input) {
      const type = input.type;
      const onCard = !!input.cardId && (type === 'expense' || type === 'income');
      const date = input.date || todayISO();
      const toCard = type === 'transfer' && input.toCardId ? D().cards.find((c) => c.id === input.toCardId) : null;
      const base = {
        id: input.id || uid(),
        type,
        amount: round2(Math.abs(Number(input.amount))),
        category: type === 'transfer' ? 'transfer' : input.category,
        description: (input.description || '').trim(),
        date,
        accountId: onCard ? null : input.accountId || DEFAULT_ACCOUNT_ID,
        cardId: onCard ? input.cardId : null,
        toAccountId: type === 'transfer' && !input.toCardId ? input.toAccountId || null : null,
        toCardId: type === 'transfer' ? input.toCardId || null : null,
        invoice: toCard ? input.invoice || invoiceForPayment(toCard, date) : onCard && input.installment ? input.invoice || null : null,
        status: !onCard && input.status === 'pending' ? 'pending' : 'paid',
        autoPay: input.autoPay !== false,
        recurring: !!input.recurring && !input.installment,
        recurringOf: input.recurringOf || null,
        forMonth: input.forMonth || null,
        skipMonths: input.skipMonths || [],
        installment: input.installment || null,
        assetId: input.assetId || null,
        goalId: input.goalId || null,
        source: input.source || 'manual',
        importId: input.importId || null,
        connectionId: input.connectionId || null,
        createdAt: input.createdAt || Date.now(),
        loggedOn: input.loggedOn || todayISO(),
      };
      let rows = [base];
      if (!input.id && onCard && type === 'expense' && Number(input.installments) > 1) {
        rows = buildInstallments(base, Number(input.installments), D().cards.find((c) => c.id === input.cardId));
      }
      await db.putMany('transactions', rows);
      const ids = new Set(rows.map((r) => r.id));
      const gen = pendingRecurring(D().txs.filter((t) => !ids.has(t.id)).concat(rows)).filter(notDeleted(await db.getTombstones())).map(autoRecord);
      if (gen.length) await db.putMany('transactions', gen, { touch: false });
      setData((d) => ({ ...d, txs: d.txs.filter((t) => !ids.has(t.id)).concat(rows, gen) }));
      changed();
      return rows[0];
    },

    /** Deletes a transaction (or every parcel of an installment purchase). Returns what's needed to undo. */
    /** skip=false is used by "Undo" of a payment: the month goes back to being due instead of skipped. */
    async deleteTx(tx, { group = false, skip = true } = {}) {
      const removed = group && tx.installment?.group ? D().txs.filter((t) => t.installment?.group === tx.installment.group) : [tx];
      const ids = new Set(removed.map((r) => r.id));
      for (const r of removed) await db.remove('transactions', r.id);
      let prevTpl = null;
      let upd = null;
      if (tx.recurringOf && skip) {
        const tpl = D().txs.find((t) => t.id === tx.recurringOf);
        if (tpl) {
          prevTpl = tpl;
          upd = { ...tpl, skipMonths: [...new Set([...(tpl.skipMonths || []), tx.forMonth || monthKey(tx.date)])] };
          await db.put('transactions', upd);
        }
      }
      // A deleted bank transaction must not come back on the next sync.
      const gone = removed.map((r) => r.importId).filter(Boolean);
      if (gone.length) await db.setMeta('deletedImports', [...new Set([...((await db.getMeta('deletedImports')) || []), ...gone])].slice(-5000));
      setData((d) => ({ ...d, txs: d.txs.filter((t) => !ids.has(t.id)).map((t) => (upd && t.id === upd.id ? upd : t)) }));
      changed();
      return { removed, prevTpl };
    },
    async restoreTxs({ removed, prevTpl }) {
      const rows = [...removed, ...(prevTpl ? [prevTpl] : [])];
      await db.putMany('transactions', rows);
      await db.dropTombstones('transactions', removed.map((r) => r.id));
      const back = new Set(removed.map((r) => r.importId).filter(Boolean));
      if (back.size) await db.setMeta('deletedImports', ((await db.getMeta('deletedImports')) || []).filter((x) => !back.has(x)));
      const ids = new Set(rows.map((r) => r.id));
      setPart('txs', (l) => l.filter((t) => !ids.has(t.id)).concat(rows));
      changed();
    },
    /** Deletes with an "Undo" button in the toast. */
    async deleteTxUndo(tx, opts) {
      const snap = await A.deleteTx(tx, opts);
      toast(snap.removed.length > 1 ? tr('tx.deletedN', { n: snap.removed.length }) : tr('tx.deleted'), 'ok', {
        label: tr('common.undo'), run: () => A.restoreTxs(snap),
      });
    },

    // ----- bills agenda -----
    async markPaid(tx) {
      const today = todayISO();
      const upd = {
        ...tx, status: 'paid', date: tx.date > today ? today : tx.date,
        forMonth: tx.recurringOf ? tx.forMonth || monthKey(tx.date) : tx.forMonth || null,
        // A recurring template paid early keeps its original day for the next months.
        anchorDate: tx.recurring && !tx.recurringOf ? tx.anchorDate || tx.date : tx.anchorDate,
      };
      await db.put('transactions', upd);
      setPart('txs', (l) => l.map((t) => (t.id === upd.id ? upd : t)));
      changed();
      return upd;
    },
    /** Pays (or receives) a future occurrence of a recurring transaction now. */
    async payRecurring(item) {
      const tpl = item.template;
      const today = todayISO();
      return A.saveTx({
        id: `rec_${tpl.id}_${item.mk}`, // same id the automatic generation would use: never two for one month
        type: tpl.type, amount: tpl.amount, category: tpl.category, description: tpl.description,
        accountId: tpl.accountId, cardId: tpl.cardId, toAccountId: tpl.toAccountId, toCardId: tpl.toCardId,
        assetId: tpl.assetId, goalId: tpl.goalId, date: item.date > today ? today : item.date,
        recurringOf: tpl.id, forMonth: item.mk, source: 'recurring', status: 'paid',
      });
    },
    /** "Undo" of payRecurring: the month goes back to being due (kept, not deleted, so no device loses it). */
    async unpayRecurring(tx, item) {
      const cur = D().txs.find((t) => t.id === tx.id) || tx;
      const auto = item.template?.autoPay !== false;
      const upd = { ...cur, status: 'pending', date: item.date, ...(auto ? { autoConfirm: true } : {}) };
      await db.put('transactions', upd);
      setPart('txs', (l) => l.map((t) => (t.id === upd.id ? upd : t)));
      changed();
    },
    async skipRecurring(item) {
      const tpl = D().txs.find((t) => t.id === item.template.id);
      if (!tpl) return;
      const upd = { ...tpl, skipMonths: [...new Set([...(tpl.skipMonths || []), item.mk])] };
      await db.put('transactions', upd);
      setPart('txs', (l) => l.map((t) => (t.id === upd.id ? upd : t)));
      changed();
    },
    async payInvoice({ card, mk, amount, accountId, date }) {
      return A.saveTx({
        type: 'transfer', amount, accountId: accountId || card.payFrom || DEFAULT_ACCOUNT_ID, toCardId: card.id, invoice: mk,
        description: tr('card.payDesc', { c: card.name }), date: date || todayISO(), status: 'paid',
      });
    },

    // ----- the user's own categories -----
    async saveCategory(c) {
      const prev = D().categories.find((x) => x.id === c.id);
      const id = c.id || uid();
      const item = {
        ...prev, ...c, id, key: prev?.key || `c_${id.replace(/-/g, '').slice(0, 10)}`,
        name: (c.name || '').trim().slice(0, 30), type: c.type === 'income' ? 'income' : 'expense',
        icon: c.icon || 'tag', color: c.color || '#94a3b8', createdAt: prev?.createdAt || Date.now(),
      };
      await db.put('categories', item);
      setPart('categories', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    /** Removes a category; its transactions and budget move to "Outros". */
    async deleteCategory(cat) {
      const fallback = cat.type === 'income' ? 'other_income' : 'other';
      const moved = D().txs.filter((x) => x.category === cat.key).map((x) => ({ ...x, category: fallback }));
      if (moved.length) await db.putMany('transactions', moved);
      const budgets = D().budgets.filter((b) => b.category === cat.key);
      for (const b of budgets) await db.remove('budgets', b.id);
      await db.remove('categories', cat.id);
      const ids = new Map(moved.map((x) => [x.id, x]));
      setData((d) => ({
        ...d,
        categories: d.categories.filter((x) => x.id !== cat.id),
        budgets: d.budgets.filter((b) => b.category !== cat.key),
        txs: d.txs.map((x) => ids.get(x.id) || x),
      }));
      changed();
      return moved.length;
    },

    // ----- accounts & cards -----
    async saveAccountItem(a) {
      const prev = D().accounts.find((x) => x.id === a.id);
      const item = {
        type: 'checking', color: '#10b981', institution: '', initialBalance: 0, ...prev, ...a,
        id: a.id || uid(), name: (a.name || '').trim() || prev?.name || tr('acc.defaultName'),
        initialBalance: round2(Number(a.initialBalance ?? prev?.initialBalance ?? 0) || 0), createdAt: prev?.createdAt || Date.now(),
      };
      await db.put('accounts', item);
      setPart('accounts', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    /** Makes the account show `target` today by moving its starting balance (reports are not affected). */
    async setAccountBalance(acc, target) {
      const current = accountBalance(acc, D().txs);
      return A.saveAccountItem({ ...acc, initialBalance: round2((Number(acc.initialBalance) || 0) + Number(target) - current) });
    },
    async deleteAccountItem(acc) {
      if (acc.id === DEFAULT_ACCOUNT_ID) return 'kept';
      const used = D().txs.some((t) => t.accountId === acc.id || t.toAccountId === acc.id);
      if (used) { await A.saveAccountItem({ ...acc, archived: true }); return 'archived'; }
      await db.remove('accounts', acc.id);
      setPart('accounts', (l) => l.filter((x) => x.id !== acc.id));
      changed();
      return 'deleted';
    },
    async saveCard(c) {
      const prev = D().cards.find((x) => x.id === c.id);
      const item = {
        brand: 'other', color: '#8b5cf6', ...prev, ...c,
        id: c.id || uid(), name: (c.name || '').trim() || prev?.name || tr('card.defaultName'),
        limit: round2(Number(c.limit ?? prev?.limit ?? 0) || 0),
        closingDay: clampDay(c.closingDay ?? prev?.closingDay, 1), dueDay: clampDay(c.dueDay ?? prev?.dueDay, 10),
        createdAt: prev?.createdAt || Date.now(),
      };
      await db.put('cards', item);
      setPart('cards', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    async deleteCard(card) {
      const used = D().txs.some((t) => t.cardId === card.id || t.toCardId === card.id);
      if (used) { await A.saveCard({ ...card, archived: true }); return 'archived'; }
      await db.remove('cards', card.id);
      setPart('cards', (l) => l.filter((x) => x.id !== card.id));
      changed();
      return 'deleted';
    },

    /** Imported statement rows go to the chosen account, or onto a card (card bill). */
    async importTxs(items, { accountId = DEFAULT_ACCOUNT_ID, cardId = null } = {}) {
      const have = new Set(D().txs.map((t) => t.importId).filter(Boolean));
      const ids = new Set(D().txs.map((t) => t.id));
      const tombs = await db.getTombstones();
      const cardOf = (id) => D().cards.find((c) => c.id === id);
      const rows = items.filter((i) => i.type !== 'skip' && (!i.importId || !have.has(i.importId))).map((i) => {
        const pay = i.type === 'cardpay' && !cardId;
        const onCard = !!cardId && (i.type === 'expense' || i.type === 'income');
        return {
          id: i.importId ? importedId(i.importId) : uid(), type: pay ? 'transfer' : i.type, amount: Math.abs(i.amount), category: pay ? 'transfer' : i.category, description: i.description,
          date: i.date, recurring: false, recurringOf: null, assetId: i.assetId || null, source: i.source || 'import',
          accountId: onCard ? null : accountId, cardId: onCard ? cardId : null,
          toCardId: pay ? i.toCardId : null, invoice: pay && cardOf(i.toCardId) ? invoiceForPayment(cardOf(i.toCardId), i.date) : null,
          status: 'paid', importId: i.importId, connectionId: i.connectionId || null, createdAt: Date.now(), loggedOn: todayISO(),
        };
      }).filter((r) => !ids.has(r.id));
      // Rows picked by the user count as new; a row the user had deleted comes back only if picked again here.
      await db.putMany('transactions', rows);
      await db.dropTombstones('transactions', rows.map((r) => r.id).filter((id) => tombs[`transactions:${id}`]));
      setPart('txs', (l) => l.concat(rows));
      changed();
      return rows.length;
    },

    async saveBudget(b) {
      const existing = D().budgets.find((x) => x.category === b.category && x.id !== b.id);
      const item = { id: b.id || existing?.id || uid(), category: b.category, limit: Number(b.limit) };
      await db.put('budgets', item);
      setPart('budgets', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
    },
    async deleteBudget(id) {
      await db.remove('budgets', id);
      setPart('budgets', (l) => l.filter((x) => x.id !== id));
      changed();
    },

    async saveGoal(g) {
      const prev = D().goals.find((x) => x.id === g.id);
      const item = {
        id: g.id || uid(), title: g.title.trim(), emoji: g.emoji || '🎯', target: Number(g.target),
        current: Number(g.current || 0), deadline: g.deadline || null,
        history: g.history || prev?.history || [], createdAt: g.createdAt || Date.now(),
      };
      await db.put('goals', item);
      setPart('goals', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    /** amount > 0 = save, < 0 = withdraw. With record=true the money also leaves/returns to the account. */
    async addFunds(goal, amount, { record = true } = {}) {
      const item = {
        ...goal,
        current: Math.max(0, Math.round((goal.current + amount) * 100) / 100),
        history: [...(goal.history || []), { date: todayISO(), amount }],
      };
      await db.put('goals', item);
      setPart('goals', (l) => l.map((x) => (x.id === item.id ? item : x)));
      if (record && amount !== 0) {
        const tx = {
          id: uid(), type: amount > 0 ? 'invest' : 'redeem', amount: Math.abs(amount), category: amount > 0 ? 'goal_save' : 'redeem',
          description: goal.title, date: todayISO(), recurring: false, recurringOf: null, goalId: goal.id, accountId: DEFAULT_ACCOUNT_ID, status: 'paid',
          source: 'manual', createdAt: Date.now(), loggedOn: todayISO(),
        };
        await db.put('transactions', tx);
        setPart('txs', (l) => l.concat(tx));
      }
      changed();
      return item;
    },
    async deleteGoal(id) {
      await db.remove('goals', id);
      setPart('goals', (l) => l.filter((x) => x.id !== id));
      changed();
    },

    // ----- investments -----
    async saveAsset(a) {
      const prev = D().assets.find((x) => x.id === a.id);
      const item = {
        ...prev, ...a,
        id: a.id || uid(), name: (a.name || '').trim(), kind: a.kind || 'outros', institution: (a.institution || '').trim(),
        source: a.source || prev?.source || 'manual', valuations: a.valuations || prev?.valuations || [],
        initialInvested: Number(a.initialInvested ?? prev?.initialInvested ?? 0), createdAt: prev?.createdAt || Date.now(),
      };
      await db.put('assets', item);
      setPart('assets', (l) => l.filter((x) => x.id !== item.id).concat(item));
      changed();
      return item;
    },
    async addValuation(asset, value) {
      const v = { date: todayISO(), at: Date.now(), value: Math.max(0, Number(value)) };
      const item = { ...asset, valuations: [...(asset.valuations || []), v].slice(-120) };
      await db.put('assets', item);
      setPart('assets', (l) => l.map((x) => (x.id === item.id ? item : x)));
      changed();
    },
    async deleteAsset(asset) {
      await db.remove('assets', asset.id);
      // Keep the cash movements (they really happened), just unlink them.
      const linked = D().txs.filter((t) => t.assetId === asset.id).map((t) => ({ ...t, assetId: null }));
      if (linked.length) await db.putMany('transactions', linked);
      setData((d) => ({
        ...d,
        assets: d.assets.filter((x) => x.id !== asset.id),
        txs: d.txs.map((t) => (t.assetId === asset.id ? { ...t, assetId: null } : t)),
      }));
      changed();
    },

    async addChat(msgs) {
      const rows = msgs.map((m, i) => ({ id: uid(), at: Date.now() + i, ...m }));
      await db.putMany('chat', rows);
      setPart('chat', (l) => l.concat(rows));
    },
    async clearChat() { await db.clear('chat'); setPart('chat', []); },

    async finishOnboarding({ name, lang, currency, income, incomeDay = 5, balance = null, sample }) {
      const next = { ...settingsRef.current, name: name.trim(), lang, currency, onboarded: true, seenV4: true, settingsAt: Date.now() };
      await db.setMeta('settings', next);
      const T = makeT(lang);
      if (sample) {
        const s = sampleData(lang);
        await db.putMany('transactions', s.transactions);
        await db.putMany('budgets', s.budgets);
        await db.putMany('goals', s.goals);
        await db.putMany('assets', s.assets);
        await db.putMany('accounts', s.accounts);
        await db.putMany('cards', s.cards);
      } else {
        const day = String(Math.min(Math.max(Number(incomeDay) || 5, 1), 28)).padStart(2, '0');
        const first = `${currentMonth()}-${day}`;
        // `balance` is what the account has today; a salary already received this month is part of it.
        const received = income > 0 && first <= todayISO() ? income : 0;
        await db.put('accounts', { ...defaultAccount(T('acc.defaultName')), initialBalance: balance == null || Number.isNaN(Number(balance)) ? 0 : round2(Number(balance) - received) });
        if (income > 0) {
          await db.put('transactions', {
            id: uid(), type: 'income', amount: income, category: 'salary', accountId: DEFAULT_ACCOUNT_ID,
            description: T('onb.salaryDesc'), date: first, status: first > todayISO() ? 'pending' : 'paid', autoPay: true,
            recurring: true, recurringOf: null, skipMonths: [], source: 'manual', createdAt: Date.now(), loggedOn: todayISO(),
          });
        }
      }
      requestPersistence();
      setSettings(next);
      await loadData();
      changed();
    },

    // ----- backup -----
    async exportBackup(password) {
      const plain = await db.exportAll();
      return password ? encryptBackup(plain, password) : plain;
    },
    async readBackup(obj, password) {
      if (obj?.encrypted) return decryptBackup(obj, password);
      return obj;
    },
    async restoreBackup(plain) { await db.importAll(plain); await loadSettings(); setAccount((await db.getMeta('account')) || null); await loadData(); changed(); },

    async wipeAll() {
      // Nothing keeps running for the erased data: no sync, no reminders from the server.
      await stopCloud();
      try { await disableReminders(await db.getMeta('pushSub')); } catch { /* offline: the server drops it after 30 days */ }
      pushedSchedule.current = '';
      await db.wipe();
      setCloud({ enabled: false, status: 'idle', lastSyncAt: null, error: null });
      cloudStop.current = false;
      setLocked(false);
      setData(EMPTY);
      setMonth(currentMonth());
      setLicense(null);
      setAccount(null);
      setTrialStart(null);
      setGuard({ fails: 0, until: 0 });
      refreshVaultInfo();
      await loadSettings();
      changed();
    },
    async removeSample() {
      const sampleIds = new Set(D().txs.filter((x) => x.source === 'sample').map((x) => x.id));
      for (const t of D().txs.filter((x) => sampleIds.has(x.id) || sampleIds.has(x.recurringOf))) await db.remove('transactions', t.id);
      for (const b of D().budgets.filter((x) => x.sample)) await db.remove('budgets', b.id);
      for (const g of D().goals.filter((x) => x.sample)) await db.remove('goals', g.id);
      for (const a of D().assets.filter((x) => x.sample)) await db.remove('assets', a.id);
      // Sample accounts/cards the user already uses for real transactions are kept (no longer marked as sample).
      const left = D().txs.filter((x) => !sampleIds.has(x.id) && !sampleIds.has(x.recurringOf));
      const usedBy = (id) => left.some((t) => t.accountId === id || t.toAccountId === id || t.cardId === id || t.toCardId === id);
      for (const c of D().cards.filter((x) => x.sample)) {
        if (usedBy(c.id)) await db.put('cards', { ...c, sample: false }); else await db.remove('cards', c.id);
      }
      for (const a of D().accounts.filter((x) => x.sample)) {
        if (a.id === DEFAULT_ACCOUNT_ID) await db.put('accounts', { ...defaultAccount(tr('acc.defaultName')), createdAt: a.createdAt });
        else if (usedBy(a.id)) await db.put('accounts', { ...a, sample: false });
        else await db.remove('accounts', a.id);
      }
      await loadData();
      changed();
    },

    // ----- security -----
    async setPin(pin) {
      if (!vault.enabled) await vault.create(pin);
      else await vault.changePin(pin);
      if (settingsRef.current.pinHash) {
        const next = { ...settingsRef.current, pinHash: null };
        setSettings(next);
        await db.setMeta('settings', next);
      }
      refreshVaultInfo();
      changed();
    },
    async removePin() {
      await vault.disable();
      refreshVaultInfo();
      changed();
    },
    async unlock(pin) {
      const g = (await db.getMeta('pinGuard')) || { fails: 0, until: 0 };
      if (g.until > Date.now()) return { ok: false, waitMs: g.until - Date.now() };
      let ok;
      if (vault.enabled) {
        ok = await vault.unlock(pin);
      } else if (settingsRef.current.pinHash) {
        // Old PIN from version 2: check it, then move the data into the encrypted vault.
        ok = (await legacyHash(pin)) === settingsRef.current.pinHash;
        if (ok) {
          await vault.create(pin);
          const next = { ...settingsRef.current, pinHash: null };
          setSettings(next);
          await db.setMeta('settings', next);
          refreshVaultInfo();
        }
      } else ok = true;
      if (!ok) {
        const fails = g.fails + 1;
        const waitSec = fails >= MAX_TRIES ? Math.min(30 * 2 ** (fails - MAX_TRIES), 900) : 0;
        const ng = { fails, until: waitSec ? Date.now() + waitSec * 1000 : 0 };
        await db.setMeta('pinGuard', ng);
        setGuard(ng);
        return { ok: false, waitMs: waitSec * 1000, left: Math.max(MAX_TRIES - fails, 0) };
      }
      await db.setMeta('pinGuard', { fails: 0, until: 0 });
      setGuard({ fails: 0, until: 0 });
      await loadData();
      lastActive.current = Date.now();
      setLocked(false);
      return { ok: true };
    },
    async enableBiometric() {
      const reg = await registerBiometric(settingsRef.current.name || 'BloomFi');
      await vault.enableBio(reg);
      refreshVaultInfo();
    },
    async disableBiometric() { await vault.disableBio(); refreshVaultInfo(); },
    async unlockBiometric() {
      const secret = await biometricSecret(vault.bioInfo);
      const ok = await vault.unlockWithSecret(secret);
      if (ok) {
        await db.setMeta('pinGuard', { fails: 0, until: 0 });
        await loadData();
        lastActive.current = Date.now();
        setLocked(false);
      }
      return ok;
    },
    lock,

    // ----- subscription -----
    async startCheckout(email) {
      const trialEnd = entitlement.status === 'trial' ? Math.floor(entitlement.trialEnd / 1000) : undefined;
      const r = await api('billing/checkout', { method: 'POST', body: { email, accountToken: account?.token, trialEnd } });
      window.location.href = r.url;
    },
    async loginStart(email) { return api('auth/start', { method: 'POST', body: { email } }); },
    async loginVerify(challenge, code) {
      const r = await api('auth/verify', { method: 'POST', body: { challenge, code } });
      if (r.accountToken) await saveAccount({ token: r.accountToken, email: r.email });
      await saveLicense(r.license || null);
      changed();
      return r;
    },
    async redeemAccessCode(code) {
      const r = await api('license', { method: 'POST', body: { accountToken: code.trim() } });
      if (!r.license) throw Object.assign(new Error('no_license'), { code: r.status || 'no_license' });
      await saveAccount({ token: code.trim(), email: r.email });
      await saveLicense(r.license);
      changed();
      return r;
    },
    async openPortal() {
      const r = await api('billing/portal', { method: 'POST', body: { accountToken: account?.token } });
      window.location.href = r.url;
    },
    async forgetAccount() { await saveAccount(null); await saveLicense(null); changed(); },
    refreshLicense,

    // ----- sync between devices (end-to-end encrypted) -----
    async cloudExists() {
      if (!license?.token) return null;
      return api('sync?meta=1', { token: license.token });
    },
    /** mode: 'create' (first device), 'replace' (use the cloud data here) or 'merge' (join both). */
    async cloudSetup(password, mode) {
      if (!license?.token) throw Object.assign(new Error('subscription_required'), { code: 'subscription_required' });
      const remote = await api('sync', { token: license.token, timeout: 60000 });
      let salt;
      let key;
      if (remote.data) {
        salt = saltOf(remote.data);
        key = await deriveSyncKey(password, salt);
        await openSnapshot(remote.data, key); // wrong password -> throws
      } else {
        salt = newSalt();
        key = await deriveSyncKey(password, salt);
      }
      await stopCloud();
      cloudStop.current = false;
      await db.putSecret('syncKey', { raw: await exportKey(key) });
      const first = remote.data ? mode : 'create';
      await db.setMeta('sync', { enabled: true, salt, version: 0, lastSyncAt: null, linkedAt: Date.now(), pendingFirst: first === 'create' ? undefined : first });
      setCloud((c) => ({ ...c, enabled: true, error: null }));
      return runCloud({ first });
    },
    cloudSyncNow: () => runCloud({ manual: true }),
    async cloudDisable({ wipeRemote = false } = {}) {
      await stopCloud();
      try {
        if (wipeRemote && license?.token) await api('sync', { method: 'DELETE', token: license.token });
      } catch (e) {
        cloudStop.current = false; // nothing changed: sync keeps going
        throw e;
      }
      await db.delMeta('sync');
      await db.delSecret('syncKey');
      setCloud({ enabled: false, status: 'idle', lastSyncAt: null, error: null });
      cloudStop.current = false;
    },

    // ----- bill reminders -----
    async remindersOn() {
      const sub = await enableReminders(serverCfg?.push?.enabled ? serverCfg.push.publicKey : null);
      if (sub) await db.setMeta('pushSub', sub); else await db.delMeta('pushSub');
      await A.updateSettings({ reminders: { ...settingsRef.current.reminders, enabled: true } });
      pushedSchedule.current = '';
      return { push: !!sub };
    },
    async remindersOff() {
      await disableReminders(await db.getMeta('pushSub'));
      await db.delMeta('pushSub');
      await A.updateSettings({ reminders: { ...settingsRef.current.reminders, enabled: false } });
    },
    async remindersSet(patch) {
      await A.updateSettings({ reminders: { ...settingsRef.current.reminders, ...patch } });
      pushedSchedule.current = '';
    },
    async remindersTest() {
      const sub = await db.getMeta('pushSub');
      const tr2 = makeT(settingsRef.current.lang);
      if (sub && serverCfg?.push?.enabled) return sendTest(sub.endpoint, settingsRef.current.lang);
      const reg = await navigator.serviceWorker?.ready;
      await reg?.showNotification(tr2('rem.testTitle'), { body: tr2('rem.testBody'), icon: '/pwa-192.png', tag: 'test' });
      return { ok: true, local: true };
    },

    // ----- Open Finance -----
    async connectBank() {
      const t = makeT(settingsRef.current.lang);
      const live = !!serverCfg?.openFinance?.enabled;
      let item;
      if (live) {
        item = await openConnect({ license: license?.token, sandbox: serverCfg.openFinance.sandbox, lang: settingsRef.current.lang });
        if (!item) return null;
      } else {
        item = { id: `demo-${uid().slice(0, 8)}`, connector: { name: t('of.demoBank'), primaryColor: '8b5cf6' } };
      }
      const conn = {
        id: item.id, name: item.connector?.name || 'Banco', color: item.connector?.primaryColor ? `#${String(item.connector.primaryColor).replace('#', '')}` : '#0bf28b',
        imageUrl: item.connector?.imageUrl || '', demo: !live, createdAt: Date.now(), lastSync: null, status: 'UPDATING',
      };
      await db.put('connections', conn);
      setPart('connections', (l) => l.filter((c) => c.id !== conn.id).concat(conn));
      changed();
      return conn;
    },

    async syncConnection(conn) {
      setSyncing(conn.id);
      try {
        // Re-read from 10 days before the last sync (never more than 90 days back), so a long gap loses nothing.
        const lastDay = conn.lastSync ? toISO(new Date(conn.lastSync)) : null;
        const from = lastDay ? [addDays(lastDay, -10), addDays(todayISO(), -90)].sort().pop() : addDays(todayISO(), -90);
        const raw = conn.demo ? demoItemData(conn.id) : await fetchItemData({ license: license?.token, itemId: conn.id, from });
        const mapped = mapItemData(raw, conn.id);
        const { txs, assets } = mapped;
        // Keep what the user customised (name, colour, hidden) when the bank sends fresh numbers.
        const merge = (list, prevList) => list.map((n) => {
          const p = prevList.find((x) => x.id === n.id);
          return p ? { ...n, name: p.name, color: p.color, archived: !!p.archived, createdAt: p.createdAt } : n;
        });
        const accounts = merge(mapped.accounts, D().accounts);
        const cards = merge(mapped.cards, D().cards);
        const have = new Set([...D().txs.map((t) => t.importId).filter(Boolean), ...((await db.getMeta('deletedImports')) || [])]);
        const ids = new Set(D().txs.map((t) => t.id));
        const keep = notDeleted(await db.getTombstones());
        const fresh = txs.filter((t) => !have.has(t.importId)).map((i) => autoRecord({
          ...i, id: importedId(i.importId), recurring: false, recurringOf: null, assetId: null, createdAt: Date.now(),
        })).filter((r) => !ids.has(r.id) && keep(r));
        if (accounts.length) await db.putMany('accounts', accounts);
        if (cards.length) await db.putMany('cards', cards);
        if (fresh.length) await db.putMany('transactions', fresh, { touch: false });
        if (assets.length) await db.putMany('assets', assets);
        const upd = { ...conn, lastSync: Date.now(), status: raw.item?.status || 'UPDATED', name: raw.item?.connector?.name || conn.name };
        await db.put('connections', upd);
        setData((d) => ({
          ...d,
          txs: d.txs.concat(fresh),
          assets: d.assets.filter((a) => !assets.some((n) => n.id === a.id)).concat(assets),
          accounts: d.accounts.filter((a) => !accounts.some((n) => n.id === a.id)).concat(accounts),
          cards: d.cards.filter((a) => !cards.some((n) => n.id === a.id)).concat(cards),
          connections: d.connections.map((c) => (c.id === upd.id ? upd : c)),
        }));
        changed();
        return { added: fresh.length, assets: assets.length, accounts: accounts.length + cards.length };
      } finally {
        setSyncing(null);
      }
    },

    async disconnectBank(conn, { removeData = false } = {}) {
      if (!conn.demo) {
        try { await deleteItem({ license: license?.token, itemId: conn.id }); } catch (e) { if (e.status !== 404) throw e; }
      }
      await db.remove('connections', conn.id);
      const mine = (x) => x.connectionId === conn.id;
      for (const a of D().assets.filter(mine)) await db.remove('assets', a.id);
      // Bank accounts/cards stop updating: delete them, or keep them hidden so old transactions keep their names.
      const hide = (x) => ({ ...x, archived: true, source: 'manual', bankBalance: undefined, bankUsed: undefined, bankAvailable: undefined });
      if (removeData) {
        for (const t of D().txs.filter(mine)) await db.remove('transactions', t.id);
        for (const a of D().accounts.filter(mine)) await db.remove('accounts', a.id);
        for (const c of D().cards.filter(mine)) await db.remove('cards', c.id);
      } else {
        const ha = D().accounts.filter(mine).map(hide), hc = D().cards.filter(mine).map(hide);
        if (ha.length) await db.putMany('accounts', ha);
        if (hc.length) await db.putMany('cards', hc);
      }
      setData((d) => ({
        ...d,
        txs: removeData ? d.txs.filter((x) => !mine(x)) : d.txs,
        accounts: removeData ? d.accounts.filter((x) => !mine(x)) : d.accounts.map((x) => (mine(x) ? hide(x) : x)),
        cards: removeData ? d.cards.filter((x) => !mine(x)) : d.cards.map((x) => (mine(x) ? hide(x) : x)),
        assets: d.assets.filter((a) => !mine(a)),
        connections: d.connections.filter((c) => c.id !== conn.id),
      }));
      changed();
    },
  }; return A; }, [data, account, license, serverCfg, entitlement, lock, loadData, loadSettings, saveAccount, saveLicense, refreshLicense, settings.lang]); // eslint-disable-line react-hooks/exhaustive-deps

  // The user's own categories: registered for icons/colours and translated by their own name.
  const t = useMemo(() => {
    setCustomCategories(data.categories);
    const base = makeT(settings.lang);
    const names = new Map(data.categories.map((c) => [`cat.${c.key}`, c.name]));
    return (key, vars) => names.get(key) ?? base(key, vars);
  }, [settings.lang, data.categories]);
  const rawMoney = useMemo(() => makeMoney(settings.lang, settings.currency), [settings.lang, settings.currency]);
  const money = useMemo(() => {
    if (!settings.hideValues) return rawMoney;
    const symbol = rawMoney(0).replace(/[\d.,\s ]/g, '');
    return () => `${symbol} •••••`;
  }, [rawMoney, settings.hideValues]);

  // Balances, invoices and the bills agenda, shared by every page.
  const today = todayISO();
  const sortedAccounts = useMemo(() => [...data.accounts].sort((a, b) => (b.id === DEFAULT_ACCOUNT_ID) - (a.id === DEFAULT_ACCOUNT_ID) || (a.createdAt || 0) - (b.createdAt || 0)), [data.accounts]);
  const sortedCards = useMemo(() => [...data.cards].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)), [data.cards]);
  const ledger = useMemo(() => {
    const tot = totals({ accounts: sortedAccounts, cards: sortedCards, txs: data.txs }, today);
    const ag = agenda({ txs: data.txs, cards: sortedCards }, today, 45);
    // Only what needs the user's action counts for the badge (automatic recurring items post themselves).
    const actionable = ag.filter((i) => i.type !== 'income' && i.type !== 'redeem' && !(i.kind === 'recurring' && i.template.autoPay !== false) && !i.tx?.autoConfirm);
    return {
      ...tot, agenda: ag, today,
      overdue: actionable.filter((i) => i.overdue).length,
      dueSoon: actionable.filter((i) => !i.overdue && i.date <= addDays(today, 3)).length,
    };
  }, [sortedAccounts, sortedCards, data.txs, today]);
  const activeAccounts = useMemo(() => sortedAccounts.filter((a) => !a.archived), [sortedAccounts]);

  // ---------- bill reminders ----------
  const pushedSchedule = useRef('');
  const rem = settings.reminders || {};
  useEffect(() => {
    if (!ready || locked || !rem.enabled || !pushSupported()) return undefined;
    const tt = makeT(settings.lang);
    const label = (i) => (i.kind === 'invoice' ? tt('ag.invoiceOf', { c: i.description }) : i.description || tt(`cat.${i.category}`));
    const timer = setTimeout(async () => {
      // 1) once a day, when the app opens
      const last = await db.getMeta('lastLocalReminder');
      const shown = await localReminder({ agenda: ledger.agenda, t: tt, money: rawMoney, label, detail: rem.detail }, last);
      if (shown) await db.setMeta('lastLocalReminder', shown);
      // 2) schedule push notifications for the coming days
      if (!serverCfg?.push?.enabled) return;
      // The browser may renew the subscription (or it may come from a backup): always use the current one.
      const saved = await db.getMeta('pushSub');
      const sub = await currentSubscription(serverCfg.push.publicKey);
      if (!sub) return;
      if (saved?.endpoint !== sub.endpoint) {
        if (saved?.endpoint) disableReminders({ endpoint: saved.endpoint }, { keepLocal: true });
        await db.setMeta('pushSub', sub);
        pushedSchedule.current = '';
      }
      const items = buildReminders(ledger.agenda, { hour: rem.hour ?? 9, detail: !!rem.detail, t: tt, money: rawMoney, label });
      const sig = JSON.stringify(items);
      if (sig === pushedSchedule.current) return;
      try { await sendSchedule(sub, items); pushedSchedule.current = sig; } catch { /* offline: try again later */ }
    }, 2500);
    return () => clearTimeout(timer);
  }, [ready, locked, rem.enabled, rem.hour, rem.detail, ledger.agenda, serverCfg, settings.lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const activeCards = useMemo(() => sortedCards.filter((c) => !c.archived), [sortedCards]);

  const value = {
    ready, settings, locked, vaultInfo, guard, month, setMonth, t, money, rawMoney, lang: settings.lang,
    ...data, ledger, activeAccounts, activeCards,
    toast, dismissToast, toastMsg, txModal, openTx: (tx = {}) => setTxModal(tx), closeTx: () => setTxModal(null),
    hasSample: data.txs.some((x) => x.source === 'sample') || data.assets.some((x) => x.sample),
    serverCfg, entitlement, account, licensePayload: licPayload, syncing,
    ofMode: serverCfg?.openFinance?.enabled ? 'live' : 'demo',
    isArtifact: IS_ARTIFACT,
    cloud,
    ...actions,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
