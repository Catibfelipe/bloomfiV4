/**
 * BloomFi API — one request handler for every /api/* route.
 *
 * Who someone is and what they paid for is carried in signed tokens, and
 * the source of truth for payments is Stripe itself. Open Finance data is
 * fetched from Pluggy on demand and never stored on the server. The only
 * things kept (server/storage.js) are encrypted sync copies, which the
 * server cannot read, and bill-reminder schedules.
 */
import {
  signHS, verifyHS, signES, verifyES, parseJwk, publicFromPrivate, now, sha256hex, randomDigits, randomId, safeEqual,
} from './crypto.js';
import { getEnv, HttpError, stripe, pluggy, sendLoginCode } from './services.js';
import { getKV } from './storage.js';
import { vapidPublicKey, sendPush, allowedEndpoint } from './webpush.js';

const DAY = 86400;
const GRACE_DAYS = 3;
const MAX_LICENSE_DAYS = 40;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  });

async function readBody(req, max = 10_000) {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  const text = await req.text();
  if (text.length > max) throw new HttpError(413, 'body_too_large');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new HttpError(400, 'invalid_json'); }
}

// Best-effort in-memory limiter (per server instance) on top of Netlify's rate limit.
const buckets = new Map();
function limit(key, max, windowSec) {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < t) { buckets.set(key, { n: 1, reset: t + windowSec * 1000 }); return; }
  b.n += 1;
  if (b.n > max) throw new HttpError(429, 'too_many_requests');
  if (buckets.size > 5000) buckets.clear();
}

function vapidKey(env) {
  try { const jwk = parseJwk(env.vapidJwk); return jwk?.d ? jwk : null; } catch { return null; }
}

// ---------------- bill reminders (Web Push) ----------------
const MAX_REMINDERS = 60;
function cleanReminders(items) {
  const t = now();
  return (Array.isArray(items) ? items : [])
    .filter((i) => Number.isFinite(i?.at) && i.at > t - DAY && i.at < t + 70 * DAY)
    .slice(0, MAX_REMINDERS)
    .map((i) => ({
      at: Math.floor(i.at),
      title: String(i.title || 'BloomFi').slice(0, 60),
      body: String(i.body || '').slice(0, 160),
      tag: String(i.tag || 'bills').replace(/[^\w:-]/g, '').slice(0, 40) || 'bills',
    }))
    .sort((a, b) => a.at - b.at);
}

/** Runs every hour (Netlify scheduled function): sends the reminders that are due. */
export async function runPushCron(env = getEnv(), at = now()) {
  const jwk = vapidKey(env);
  if (!jwk) return { sent: 0, removed: 0, skipped: 'vapid_not_configured' };
  const store = await getKV('push');
  let sent = 0, removed = 0;
  const one = async (key) => {
    const rec = await store.get(key);
    if (!rec?.sub) return;
    const items = rec.items || [];
    const due = items.filter((i) => i.at <= at && i.at > at - 6 * 3600);
    const keep = items.filter((i) => i.at > at);
    if (due.length) {
      const last = due[due.length - 1]; // several due at once: only the latest, no spam
      const r = await sendPush(rec.sub, { title: last.title, body: last.body, tag: last.tag, url: '/app/#agenda' }, { jwk, subject: env.vapidSubject }).catch(() => 'failed');
      if (r === 'gone') { await store.delete(key); removed++; return; }
      if (r === 'sent') sent++;
    }
    if (keep.length !== items.length) await store.set(key, { ...rec, items: keep });
    else if (!keep.length && (rec.updatedAt || 0) < at - 30 * DAY) { await store.delete(key); removed++; }
  };
  // Many devices share the same hour: work in parallel (bounded), shuffled so nobody is always last.
  const keys = (await store.keys()).sort(() => Math.random() - 0.5);
  const started = Date.now();
  let next = 0;
  const worker = async () => {
    while (next < keys.length && Date.now() - started < 24000) await one(keys[next++]).catch(() => {});
  };
  await Promise.all(Array.from({ length: 24 }, worker));
  return { sent, removed, pending: Math.max(keys.length - next, 0) };
}

// ---------------- encrypted sync ----------------
const MAX_SYNC = 4_500_000;
const syncKey = (lic) => sha256hex(`sync:${lic.sub}`);

function licenseKeys(env) {
  const priv = parseJwk(env.licenseJwk);
  if (!priv?.d) throw new HttpError(503, 'license_key_missing');
  return { priv, pub: publicFromPrivate(priv) };
}

// ---------------- licenses ----------------
const STATUS_RANK = { active: 0, trialing: 0, past_due: 1, unpaid: 2, incomplete: 3, paused: 4, canceled: 5, incomplete_expired: 6 };
const periodEnd = (s) => s.current_period_end ?? s.items?.data?.[0]?.current_period_end ?? null;

async function bestSubscription(env, customerId) {
  const list = await stripe(env, 'GET', '/subscriptions', { customer: customerId, status: 'all', limit: 10 });
  const subs = (list.data || []).slice().sort((a, b) =>
    (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || (periodEnd(b) || 0) - (periodEnd(a) || 0));
  return subs[0] || null;
}

async function issueLicense(env, payload) {
  const { priv } = licenseKeys(env);
  const exp = Math.min(payload.exp, now() + MAX_LICENSE_DAYS * DAY);
  if (exp <= now()) return null;
  return signES({ ...payload, plan: 'premium', iat: now(), exp }, priv);
}

async function licenseForAccount(env, account) {
  if (account.kind === 'free') {
    if (!env.freeEmails.includes(account.email)) return { license: null, status: 'revoked' };
    const lic = await issueLicense(env, { sub: account.sub, email: account.email, status: 'free', renews: true, exp: now() + 30 * DAY });
    return { license: lic, status: 'free' };
  }
  if (account.kind === 'gift') {
    const until = account.until || now() + 30 * DAY;
    const lic = await issueLicense(env, { sub: account.sub, email: account.email, status: 'gift', renews: false, periodEnd: until, exp: until });
    return { license: lic, status: lic ? 'gift' : 'expired' };
  }
  if (account.kind !== 'stripe') return { license: null, status: 'invalid' };

  const sub = await bestSubscription(env, account.sub);
  if (!sub) return { license: null, status: 'none' };
  const end = periodEnd(sub) || now();
  let exp;
  if (sub.status === 'active' || sub.status === 'trialing') {
    exp = sub.cancel_at_period_end ? end : end + GRACE_DAYS * DAY;
  } else if (sub.status === 'past_due') {
    // Payment failed and Stripe is retrying: short grace so the person can fix the card.
    exp = Math.min(now() + GRACE_DAYS * DAY, end + 10 * DAY);
  } else {
    return { license: null, status: sub.status };
  }
  const lic = await issueLicense(env, {
    sub: account.sub, email: account.email, status: sub.status, renews: !sub.cancel_at_period_end, periodEnd: end, exp,
  });
  return { license: lic, status: lic ? sub.status : 'expired' };
}

async function accountFromToken(env, token) {
  const acc = await verifyHS(token, env.appSecret);
  if (!acc || acc.typ !== 'account') throw new HttpError(401, 'invalid_account');
  return acc;
}

async function requireLicense(env, req) {
  const auth = req.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const { pub } = licenseKeys(env);
  const lic = await verifyES(token, pub);
  if (!lic) throw new HttpError(401, 'subscription_required');
  return lic;
}

// ---------------- Open Finance helpers ----------------
async function ownedItem(env, itemId, lic) {
  if (!/^[\w-]{6,64}$/.test(itemId || '')) throw new HttpError(400, 'invalid_item');
  const item = await pluggy(env, 'GET', `/items/${encodeURIComponent(itemId)}`);
  if (!item || item.clientUserId !== lic.sub) throw new HttpError(404, 'item_not_found');
  return item;
}

const slimItem = (i) => ({
  id: i.id, status: i.status, executionStatus: i.executionStatus, lastUpdatedAt: i.lastUpdatedAt, createdAt: i.createdAt,
  connector: i.connector ? { id: i.connector.id, name: i.connector.name, imageUrl: i.connector.imageUrl, primaryColor: i.connector.primaryColor } : null,
});
const slimAccount = (a) => ({
  id: a.id, itemId: a.itemId, type: a.type, subtype: a.subtype, name: a.marketingName || a.name, number: a.number,
  balance: a.balance, currencyCode: a.currencyCode,
  credit: a.creditData ? {
    limit: a.creditData.creditLimit ?? null, available: a.creditData.availableCreditLimit ?? null, brand: a.creditData.brand || null,
    closeDate: a.creditData.balanceCloseDate || null, dueDate: a.creditData.balanceDueDate || null,
  } : null,
});
const slimTx = (t) => ({
  id: t.id, accountId: t.accountId, description: t.description || t.descriptionRaw || '', amount: t.amount,
  date: t.date, type: t.type, category: t.category || null, status: t.status,
  installment: t.creditCardMetadata?.installmentNumber ? `${t.creditCardMetadata.installmentNumber}/${t.creditCardMetadata.totalInstallments}` : null,
});
const slimInvestment = (v) => ({
  id: v.id, itemId: v.itemId, name: v.name, code: v.code, type: v.type, subtype: v.subtype,
  balance: v.balance, amount: v.amount, amountOriginal: v.amountOriginal, amountProfit: v.amountProfit,
  date: v.date, dueDate: v.dueDate, issuer: v.issuer, status: v.status,
});

async function listTransactions(env, accountId, from) {
  const out = [];
  const q = new URLSearchParams({ accountId });
  if (from) q.set('dateFrom', from);
  let path = `/v2/transactions?${q}`;
  try {
    for (let pages = 0; path && pages < 30; pages++) {
      const d = await pluggy(env, 'GET', path);
      out.push(...(d.results || []));
      path = d.next ? `/v2/transactions${d.next.startsWith('?') ? d.next : `?${d.next}`}` : null;
    }
    return out;
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 404) throw e;
  }
  // Older API (page based)
  for (let page = 1; page <= 30; page++) {
    const p = new URLSearchParams({ accountId, pageSize: '500', page: String(page) });
    if (from) p.set('from', from);
    const d = await pluggy(env, 'GET', `/transactions?${p}`);
    out.push(...(d.results || []));
    if (!d.totalPages || page >= d.totalPages) break;
  }
  return out;
}

// ---------------- routes ----------------
const routes = {
  'GET config': async (env) => {
    let licensePublicJwk = null;
    try { licensePublicJwk = licenseKeys(env).pub; } catch { /* not configured */ }
    const billing = !!(env.stripeKey && licensePublicJwk && env.appSecret);
    return json({
      billing: { enabled: billing, price: env.priceCents, currency: env.currency, trialDays: env.trialDays, interval: 'month' },
      openFinance: { enabled: billing && !!env.pluggyId, sandbox: env.pluggySandbox },
      emailLogin: billing && !!env.resendKey,
      support: { email: env.supportEmail, whatsapp: env.supportWhatsapp },
      push: { enabled: !!vapidKey(env), publicKey: vapidKey(env) ? vapidPublicKey(vapidKey(env)) : null },
      sync: { enabled: billing },
      licensePublicJwk,
    }, 200, { 'Cache-Control': 'public, max-age=300' });
  },

  'POST billing/checkout': async (env, req, body) => {
    const origin = new URL(req.url).origin;
    const params = {
      mode: 'subscription',
      success_url: `${origin}/app/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/app/?checkout=cancel`,
      locale: 'pt-BR',
      allow_promotion_codes: 'true',
      line_items: [env.stripePrice
        ? { price: env.stripePrice, quantity: 1 }
        : { quantity: 1, price_data: { currency: env.currency, unit_amount: env.priceCents, recurring: { interval: 'month' }, product_data: { name: env.productName } } }],
      subscription_data: { metadata: { app: 'bloomfi' } },
    };
    if (body.accountToken) {
      const acc = await verifyHS(body.accountToken, env.appSecret);
      if (acc?.typ === 'account' && acc.kind === 'stripe') params.customer = acc.sub;
    }
    if (!params.customer && typeof body.email === 'string' && EMAIL_RE.test(body.email.trim())) params.customer_email = body.email.trim().toLowerCase();
    // Keep the rest of the free trial: the first charge happens when it ends.
    const te = Number(body.trialEnd);
    if (te && te > now() + 2 * DAY + 300 && te < now() + (env.trialDays + 1) * DAY) params.subscription_data.trial_end = Math.floor(te);
    const s = await stripe(env, 'POST', '/checkout/sessions', params);
    return json({ url: s.url });
  },

  'POST billing/claim': async (env, req, body) => {
    const id = String(body.sessionId || '');
    if (!/^cs_[\w]{10,200}$/.test(id)) throw new HttpError(400, 'invalid_session');
    const s = await stripe(env, 'GET', `/checkout/sessions/${id}`);
    if (s.status !== 'complete' || !s.customer) throw new HttpError(409, 'checkout_not_complete');
    const email = (s.customer_details?.email || s.customer_email || '').toLowerCase();
    const account = { typ: 'account', kind: 'stripe', sub: s.customer, email, iat: now() };
    const accountToken = await signHS(account, env.appSecret);
    const { license, status } = await licenseForAccount(env, account);
    return json({ accountToken, email, license, status });
  },

  'POST license': async (env, req, body) => {
    const account = await accountFromToken(env, body.accountToken);
    const { license, status } = await licenseForAccount(env, account);
    return json({ license, status, email: account.email });
  },

  'POST billing/portal': async (env, req, body) => {
    const account = await accountFromToken(env, body.accountToken);
    if (account.kind !== 'stripe') throw new HttpError(400, 'no_billing_account');
    const origin = new URL(req.url).origin;
    try {
      const s = await stripe(env, 'POST', '/billing_portal/sessions', { customer: account.sub, return_url: `${origin}/app/#settings`, locale: 'pt-BR' });
      return json({ url: s.url });
    } catch (e) {
      // Stripe refuses portal sessions until the Customer portal is saved in the dashboard.
      if (e instanceof HttpError && /configuration|portal/i.test(e.detail || '')) throw new HttpError(409, 'portal_not_configured');
      throw e;
    }
  },

  'POST auth/start': async (env, req, body) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'invalid_email');
    limit(`otp:${email}`, 5, 15 * 60);
    const code = randomDigits(6);
    const n = randomId(12);
    const h = await sha256hex(`${code}:${n}:${env.appSecret}`);
    const challenge = await signHS({ typ: 'otp', email, n, h, exp: now() + 10 * 60 }, env.appSecret);
    await sendLoginCode(env, email, code);
    return json({ challenge });
  },

  'POST auth/verify': async (env, req, body) => {
    const ch = await verifyHS(body.challenge, env.appSecret);
    const code = String(body.code || '').replace(/\D/g, '');
    if (!ch || ch.typ !== 'otp' || code.length !== 6) throw new HttpError(400, 'invalid_code');
    limit(`verify:${ch.n}`, 6, 10 * 60);
    const h = await sha256hex(`${code}:${ch.n}:${env.appSecret}`);
    if (!safeEqual(h, ch.h)) throw new HttpError(400, 'invalid_code');

    const email = ch.email;
    if (env.freeEmails.includes(email)) {
      const account = { typ: 'account', kind: 'free', sub: `free:${email}`, email, iat: now() };
      const { license, status } = await licenseForAccount(env, account);
      return json({ accountToken: await signHS(account, env.appSecret), email, license, status });
    }
    // Find this person's Stripe customer with the best subscription.
    const customers = await stripe(env, 'GET', '/customers', { email, limit: 10 });
    let best = null;
    for (const c of customers.data || []) {
      const account = { typ: 'account', kind: 'stripe', sub: c.id, email, iat: now() };
      const r = await licenseForAccount(env, account);
      if (r.license) { best = { account, ...r }; break; }
      if (!best) best = { account, ...r };
    }
    if (!best) return json({ accountToken: null, email, license: null, status: 'none' });
    return json({ accountToken: await signHS(best.account, env.appSecret), email, license: best.license, status: best.status });
  },

  // ----- Open Finance (subscribers only) -----
  'POST of/connect-token': async (env, req, body) => {
    const lic = await requireLicense(env, req);
    const payload = { options: { clientUserId: lic.sub, avoidDuplicates: true } };
    if (body.itemId) { await ownedItem(env, String(body.itemId), lic); payload.itemId = String(body.itemId); }
    const d = await pluggy(env, 'POST', '/connect_token', payload);
    return json({ accessToken: d.accessToken });
  },

  'GET of/item': async (env, req, body, url) => {
    const lic = await requireLicense(env, req);
    return json(slimItem(await ownedItem(env, url.searchParams.get('id'), lic)));
  },

  'DELETE of/item': async (env, req, body, url) => {
    const lic = await requireLicense(env, req);
    const item = await ownedItem(env, url.searchParams.get('id'), lic);
    await pluggy(env, 'DELETE', `/items/${encodeURIComponent(item.id)}`);
    return json({ ok: true });
  },

  'GET of/accounts': async (env, req, body, url) => {
    const lic = await requireLicense(env, req);
    const item = await ownedItem(env, url.searchParams.get('itemId'), lic);
    const d = await pluggy(env, 'GET', `/accounts?itemId=${encodeURIComponent(item.id)}`);
    return json({ results: (d.results || []).map(slimAccount) });
  },

  'GET of/transactions': async (env, req, body, url) => {
    const lic = await requireLicense(env, req);
    const accountId = url.searchParams.get('accountId') || '';
    if (!/^[\w-]{6,64}$/.test(accountId)) throw new HttpError(400, 'invalid_account');
    const acc = await pluggy(env, 'GET', `/accounts/${encodeURIComponent(accountId)}`);
    await ownedItem(env, acc.itemId, lic);
    const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('from') || '') ? url.searchParams.get('from') : null;
    const list = await listTransactions(env, accountId, from);
    return json({ results: list.map(slimTx) });
  },

  // Saves (or replaces) the reminder schedule of one device. Only times and short texts, never amounts or names
  // unless the user turned that on; the push service gets them encrypted.
  'POST push': async (env, req, body) => {
    if (!vapidKey(env)) throw new HttpError(503, 'push_not_configured');
    limit(`push:${req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for') || 'local'}`, 30, 3600);
    const sub = body.subscription || {};
    if (!allowedEndpoint(sub.endpoint, env.pushAllowLocal)) throw new HttpError(400, 'invalid_endpoint');
    if (typeof sub.keys?.p256dh !== 'string' || typeof sub.keys?.auth !== 'string' || sub.keys.p256dh.length > 120 || sub.keys.auth.length > 60) throw new HttpError(400, 'invalid_keys');
    const store = await getKV('push');
    const key = await sha256hex(sub.endpoint);
    const items = cleanReminders(body.items);
    await store.set(key, { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, items, updatedAt: now() });
    return json({ ok: true, scheduled: items.length });
  },
  'POST push/remove': async (env, req, body) => {
    if (typeof body.endpoint !== 'string' || body.endpoint.length > 1000) throw new HttpError(400, 'invalid_endpoint');
    await (await getKV('push')).delete(await sha256hex(body.endpoint));
    return json({ ok: true });
  },
  'POST push/test': async (env, req, body) => {
    const jwk = vapidKey(env);
    if (!jwk) throw new HttpError(503, 'push_not_configured');
    const rec = await (await getKV('push')).get(await sha256hex(String(body.endpoint || '')));
    if (!rec) throw new HttpError(404, 'not_subscribed');
    const en = body.lang === 'en';
    const r = await sendPush(rec.sub, {
      title: 'BloomFi', body: en ? 'Bill reminders are working ✓' : 'Os lembretes de contas estão funcionando ✓', tag: 'test', url: '/app/#agenda',
    }, { jwk, subject: env.vapidSubject });
    return json({ ok: r === 'sent', result: r });
  },

  // Encrypted copy of the user's data for syncing devices. The server only ever sees ciphertext.
  'GET sync': async (env, req, body, url) => {
    const lic = await requireLicense(env, req);
    const rec = await (await getKV('sync')).get(await syncKey(lic));
    if (url.searchParams.get('meta') === '1') return json({ exists: !!rec, version: rec?.version || 0, updatedAt: rec?.updatedAt || null });
    return json(rec ? { version: rec.version, updatedAt: rec.updatedAt, data: rec.data } : { version: 0, data: null });
  },
  'PUT sync': async (env, req, body) => {
    const lic = await requireLicense(env, req);
    if (typeof body.data !== 'string' || !body.data || body.data.length > MAX_SYNC) throw new HttpError(400, 'invalid_data');
    const store = await getKV('sync');
    const key = await syncKey(lic);
    const { value: rec, tag } = await store.getVersioned(key);
    const version = rec?.version || 0;
    if (Number(body.baseVersion) !== version) return json({ error: 'conflict', version }, 409);
    const next = { version: version + 1, updatedAt: now(), data: body.data };
    // Compare-and-set: if another device wrote in between, this one merges again.
    if (!(await store.setVersioned(key, next, tag))) return json({ error: 'conflict', version: version + 1 }, 409);
    return json({ version: next.version, updatedAt: next.updatedAt });
  },
  'DELETE sync': async (env, req) => {
    const lic = await requireLicense(env, req);
    await (await getKV('sync')).delete(await syncKey(lic));
    return json({ ok: true });
  },

  'GET of/investments': async (env, req, body, url) => {
    const lic = await requireLicense(env, req);
    const item = await ownedItem(env, url.searchParams.get('itemId'), lic);
    const d = await pluggy(env, 'GET', `/investments?itemId=${encodeURIComponent(item.id)}`);
    return json({ results: (d.results || []).map(slimInvestment) });
  },
};

export async function handle(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*?\/api\//, '').replace(/\/+$/, '');
  const route = routes[`${req.method} ${path}`];
  if (!route) return json({ error: 'not_found' }, 404);
  const env = getEnv();
  try {
    if (path !== 'config' && !path.startsWith('push') && !env.appSecret) throw new HttpError(503, 'server_not_configured');
    const body = await readBody(req, path === 'sync' ? MAX_SYNC + 1000 : path.startsWith('push') ? 40_000 : 10_000);
    return await route(env, req, body, url);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.code }, e.status);
    console.error('[api]', e);
    return json({ error: 'server_error' }, 500);
  }
}
