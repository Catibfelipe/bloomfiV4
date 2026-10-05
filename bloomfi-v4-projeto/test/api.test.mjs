// Server tests against the fake services. Run: node test/api.test.mjs
import assert from 'node:assert/strict';
import { startFakeServices } from './fake-services.mjs';
import { generateLicenseKeys, randomId, verifyES, publicFromPrivate, signHS, now, b64url } from '../server/crypto.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FP = 4599;
const { server, state } = await startFakeServices(FP);
const { priv } = await generateLicenseKeys();
const { priv: vapid } = await generateLicenseKeys();
const blobs = fs.mkdtempSync(path.join(os.tmpdir(), 'bloomfi-test-'));
Object.assign(process.env, {
  VAPID_PRIVATE_JWK: JSON.stringify(vapid), PUSH_ALLOW_LOCALHOST: '1', BLOBS_DIR: blobs, SUPPORT_EMAIL: 'ajuda@bloomfi.test', SUPPORT_WHATSAPP: '+55 (11) 99999-8888',
  APP_SECRET: randomId(48), LICENSE_PRIVATE_JWK: JSON.stringify(priv),
  STRIPE_SECRET_KEY: 'sk_test_x', PLUGGY_CLIENT_ID: 'fake-id', PLUGGY_CLIENT_SECRET: 's', RESEND_API_KEY: 're_x',
  FREE_ACCESS_EMAILS: 'pai@familia.com',
  STRIPE_API_BASE: `http://localhost:${FP}`, PLUGGY_API_BASE: `http://localhost:${FP}`, RESEND_API_BASE: `http://localhost:${FP}`,
});
const { handle, runPushCron } = await import('../server/handler.js');
const pub = publicFromPrivate(priv);

const call = async (method, path, body, headers = {}) => {
  const r = await handle(new Request(`https://app.test/api/${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined,
  }));
  return { status: r.status, data: await r.json() };
};
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

// config
let r = await call('GET', 'config');
assert.equal(r.data.billing.enabled, true); assert.equal(r.data.billing.price, 1490); assert.equal(r.data.openFinance.enabled, true);
assert.equal(r.data.licensePublicJwk.d, undefined, 'private part must never leak');
ok('config exposes only the public key');
assert.equal(b64url.decode(r.data.push.publicKey).length, 65); assert.equal(r.data.sync.enabled, true);
assert.deepEqual(r.data.support, { email: 'ajuda@bloomfi.test', whatsapp: '5511999998888' });
assert.ok(!JSON.stringify(r.data).includes(vapid.d), 'VAPID private key must never leak');
ok('config: reminders public key, sync and support contact');

// unknown route + bad json
assert.equal((await call('GET', 'nope')).status, 404);
r = await handle(new Request('https://app.test/api/license', { method: 'POST', body: '{bad' }));
assert.equal(r.status, 400); ok('rejects bad routes and bad JSON');

// checkout with remaining trial
const trialEnd = now() + 5 * 86400;
r = await call('POST', 'billing/checkout', { email: 'Ana@Email.com', trialEnd });
assert.equal(r.status, 200);
const sessionId = new URL(r.data.url).searchParams.get('session_id');
const sess = state.sessions.get(sessionId);
assert.equal(sess.params.customer_email, 'ana@email.com');
assert.equal(Number(sess.params['subscription_data[trial_end]']), trialEnd);
assert.equal(sess.params['line_items[0][price_data][unit_amount]'], '1490');
assert.ok(sess.params.success_url.startsWith('https://app.test/app/?checkout=success'));
ok('checkout keeps the rest of the trial and builds the success URL from our own origin');

// trial too short is not forwarded
r = await call('POST', 'billing/checkout', { email: 'b@b.com', trialEnd: now() + 3600 });
const s2 = state.sessions.get(new URL(r.data.url).searchParams.get('session_id'));
assert.equal(s2.params['subscription_data[trial_end]'], undefined); ok('ignores a trial end that Stripe would reject');

// claim
r = await call('POST', 'billing/claim', { sessionId });
assert.equal(r.status, 200);
const { accountToken, license } = r.data;
const lic = await verifyES(license, pub);
assert.equal(lic.email, 'ana@email.com'); assert.equal(lic.status, 'trialing'); assert.ok(lic.exp > now() + 5 * 86400);
ok('claim returns account + signed license');
assert.equal((await call('POST', 'billing/claim', { sessionId: 'nope' })).status, 400); ok('claim validates session id');

// license refresh + cancellation + past_due + canceled
r = await call('POST', 'license', { accountToken });
assert.ok(await verifyES(r.data.license, pub)); ok('license refresh');
const cust = sess.customer;
const end = now() + 10 * 86400;
await fetch(`http://localhost:${FP}/__set_sub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer: cust, patch: { status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_end: end }] } } }) });
r = await call('POST', 'license', { accountToken });
let L = await verifyES(r.data.license, pub);
assert.equal(L.exp, end); assert.equal(L.renews, false); ok('canceled-at-period-end license stops exactly at period end');
await fetch(`http://localhost:${FP}/__set_sub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer: cust, patch: { status: 'past_due', cancel_at_period_end: false, items: { data: [{ current_period_end: now() - 86400 }] } } }) });
r = await call('POST', 'license', { accountToken });
L = await verifyES(r.data.license, pub);
assert.equal(L.status, 'past_due'); assert.ok(L.exp <= now() + 3 * 86400 + 5); ok('past_due gets a short grace period');
await fetch(`http://localhost:${FP}/__set_sub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer: cust, patch: { status: 'canceled' } }) });
r = await call('POST', 'license', { accountToken });
assert.equal(r.data.license, null); assert.equal(r.data.status, 'canceled'); ok('canceled subscription -> no license');
await fetch(`http://localhost:${FP}/__set_sub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ customer: cust, patch: { status: 'active', items: { data: [{ current_period_end: now() + 30 * 86400 }] } } }) });

// forged account token
r = await call('POST', 'license', { accountToken: accountToken.slice(0, -3) + 'abc' });
assert.equal(r.status, 401); ok('forged account token rejected');

// portal
r = await call('POST', 'billing/portal', { accountToken });
assert.ok(r.data.url.includes('portal=fake')); ok('billing portal');
state.noPortal = true;
r = await call('POST', 'billing/portal', { accountToken });
assert.equal(r.status, 409); assert.equal(r.data.error, 'portal_not_configured'); ok('portal not activated in Stripe -> clear error');
state.noPortal = false;

// e-mail login
r = await call('POST', 'auth/start', { email: 'ana@email.com' });
const { challenge } = r.data;
const code = state.lastCodes.get('ana@email.com');
assert.match(code, /^\d{6}$/);
assert.equal((await call('POST', 'auth/verify', { challenge, code: code === '000000' ? '111111' : '000000' })).status, 400);
r = await call('POST', 'auth/verify', { challenge, code });
assert.equal(r.status, 200); assert.ok(await verifyES(r.data.license, pub)); ok('e-mail code login finds the subscription');
assert.ok(!challenge.includes(code)); ok('challenge does not reveal the code');
r = await call('POST', 'auth/start', { email: 'not-an-email' });
assert.equal(r.status, 400); ok('invalid e-mail rejected');

// family e-mail (free) + gift code
r = await call('POST', 'auth/start', { email: 'pai@familia.com' });
r = await call('POST', 'auth/verify', { challenge: r.data.challenge, code: state.lastCodes.get('pai@familia.com') });
L = await verifyES(r.data.license, pub);
assert.equal(L.status, 'free'); ok('FREE_ACCESS_EMAILS works');
const gift = await signHS({ typ: 'account', kind: 'gift', sub: 'gift:amigo@x.com', email: 'amigo@x.com', until: now() + 100 * 86400, iat: now() }, process.env.APP_SECRET);
r = await call('POST', 'license', { accountToken: gift });
L = await verifyES(r.data.license, pub);
assert.equal(L.status, 'gift'); assert.ok(L.exp <= now() + 40 * 86400 + 5); ok('gift access code works (license capped to 40 days, renewed automatically)');

// Open Finance
assert.equal((await call('POST', 'of/connect-token', {})).status, 401); ok('Open Finance needs a subscription');
const auth = { Authorization: `Bearer ${license}` };
r = await call('POST', 'of/connect-token', {}, auth);
const ct = r.data.accessToken;
assert.equal(state.connectTokens.get(ct), cust); ok('connect token bound to the subscriber');
const item = (await (await fetch(`http://localhost:${FP}/__create_item`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connectToken: ct }) })).json()).item;
r = await call('GET', `of/item?id=${item.id}`, null, auth);
assert.equal(r.data.connector.name, 'Pluggy Bank (sandbox)');
r = await call('GET', `of/accounts?itemId=${item.id}`, null, auth);
assert.equal(r.data.results.length, 2);
const bank = r.data.results.find((a) => a.type === 'BANK');
r = await call('GET', `of/transactions?accountId=${bank.id}&from=2020-01-01`, null, auth);
assert.equal(r.data.results.length, 6); ok('transactions follow the pagination cursor');
r = await call('GET', `of/investments?itemId=${item.id}`, null, auth);
assert.equal(r.data.results.length, 3); ok('investments');

// another subscriber cannot read this item
const otherLic = (await call('POST', 'license', { accountToken: gift })).data.license;
const other = { Authorization: `Bearer ${otherLic}` };
assert.equal((await call('GET', `of/accounts?itemId=${item.id}`, null, other)).status, 404);
assert.equal((await call('GET', `of/transactions?accountId=${bank.id}`, null, other)).status, 404);
assert.equal((await call('DELETE', `of/item?id=${item.id}`, null, other)).status, 404);
ok('items are isolated between users');
assert.equal((await call('GET', 'of/accounts?itemId=../../etc', null, auth)).status, 400); ok('ids are validated');
r = await call('DELETE', `of/item?id=${item.id}`, null, auth);
assert.equal(r.data.ok, true); assert.equal(state.items.has(item.id), false); ok('disconnect removes the item at Pluggy');

// ---------------- bill reminders (Web Push) ----------------
const subtle = globalThis.crypto.subtle;
const ua = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPub = new Uint8Array(await subtle.exportKey('raw', ua.publicKey));
const authSecret = globalThis.crypto.getRandomValues(new Uint8Array(16));
const subscription = { endpoint: `http://localhost:${FP}/push/dev1`, keys: { p256dh: b64url.encode(uaPub), auth: b64url.encode(authSecret) } };
assert.equal((await call('POST', 'push', { subscription: { ...subscription, endpoint: 'https://evil.example.com/x' }, items: [] })).status, 400);
ok('reminders only go to real push services');
const t0 = now();
r = await call('POST', 'push', { subscription, items: [
  { at: t0 - 600, title: 'Conta vencendo hoje', body: '1 conta. Toque para ver na agenda.', tag: 'due:x' },
  { at: t0 + 86400, title: 'Amanhã', body: 'futuro', tag: 'due:y' },
  { at: t0 + 400 * 86400, title: 'too far', body: '' },
] });
assert.equal(r.data.scheduled, 2); ok('schedule saved (far-future items dropped)');
let cron = await runPushCron(undefined, t0);
assert.equal(cron.sent, 1); assert.equal(state.pushes.length, 1);
const got = state.pushes[0];
assert.equal(got.headers['content-encoding'], 'aes128gcm');
const [, jwt, k] = got.headers.authorization.match(/^vapid t=([^,]+), k=(.+)$/);
const vkey = await subtle.importKey('raw', b64url.decode(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
const [h, p, sg] = jwt.split('.');
assert.ok(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, vkey, b64url.decode(sg), new TextEncoder().encode(`${h}.${p}`)));
assert.equal(JSON.parse(Buffer.from(b64url.decode(p)).toString()).aud, `http://localhost:${FP}`);
ok('push signed with VAPID (valid JWT for the push service)');
// decrypt like a browser would (RFC 8291)
const bodyBytes = new Uint8Array(Buffer.from(got.body, 'base64'));
const salt = bodyBytes.slice(0, 16), idlen = bodyBytes[20], asPub = bodyBytes.slice(21, 21 + idlen), cipher = bodyBytes.slice(21 + idlen);
const hk = async (s2, ikm, info, n) => new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: s2, info }, await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']), n * 8));
const te = new TextEncoder();
const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []) }, ua.privateKey, 256));
const ikm = await hk(authSecret, shared, new Uint8Array([...te.encode('WebPush: info\0'), ...uaPub, ...asPub]), 32);
const cek = await hk(salt, ikm, te.encode('Content-Encoding: aes128gcm\0'), 16);
const nonce = await hk(salt, ikm, te.encode('Content-Encoding: nonce\0'), 12);
const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']), cipher));
assert.equal(plain[plain.length - 1], 2);
const msg = JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
assert.equal(msg.title, 'Conta vencendo hoje'); assert.equal(msg.url, '/app/#agenda');
ok('payload is encrypted end-to-end (aes128gcm) and the device can read it');
cron = await runPushCron(undefined, t0 + 60);
assert.equal(cron.sent, 0); ok('a reminder is sent only once');
state.pushGone.add('dev1');
cron = await runPushCron(undefined, t0 + 86400 + 10);
assert.equal(cron.removed, 1); ok('expired subscriptions are cleaned up');
r = await call('POST', 'push/remove', { endpoint: subscription.endpoint });
assert.equal(r.data.ok, true);

// ---------------- encrypted sync ----------------
assert.equal((await call('GET', 'sync')).status, 401); ok('sync needs a subscription');
const lic2 = (await call('POST', 'license', { accountToken })).data.license;
const A = { Authorization: `Bearer ${lic2}` };
r = await call('GET', 'sync', null, A);
assert.deepEqual(r.data, { version: 0, data: null });
r = await call('PUT', 'sync', { baseVersion: 0, data: 'cipher-1' }, A);
assert.equal(r.data.version, 1);
r = await call('PUT', 'sync', { baseVersion: 0, data: 'cipher-old' }, A);
assert.equal(r.status, 409); assert.equal(r.data.version, 1); ok('sync rejects writes based on an old version');
r = await call('GET', 'sync', null, A);
assert.equal(r.data.data, 'cipher-1');
r = await call('GET', 'sync?meta=1', null, A);
assert.equal(r.data.exists, true); assert.equal(r.data.data, undefined);
const otherSync = await call('GET', 'sync', null, other);
assert.equal(otherSync.data.version, 0); ok('each subscriber only sees their own copy');
r = await handle(new Request('https://app.test/api/sync', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...A }, body: JSON.stringify({ baseVersion: 1, data: 'x'.repeat(4_600_000) }) }));
assert.ok(r.status === 400 || r.status === 413); ok('sync size is limited');
assert.equal((await call('DELETE', 'sync', null, A)).data.ok, true);
assert.equal((await call('GET', 'sync', null, A)).data.version, 0); ok('cloud copy can be deleted');

// not configured server
delete process.env.APP_SECRET;
assert.equal((await call('POST', 'license', { accountToken })).status, 503); ok('unconfigured server answers 503, not a crash');

console.log(`\n${passed} checks passed`);
server.close();
fs.rmSync(blobs, { recursive: true, force: true });
