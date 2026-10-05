/**
 * Thin clients for the outside services. Base URLs can be overridden by
 * environment variables so the whole server can be tested locally against
 * fake services.
 */

export function getEnv() {
  const e = process.env;
  return {
    appSecret: e.APP_SECRET || '',
    licenseJwk: e.LICENSE_PRIVATE_JWK || '',
    stripeKey: e.STRIPE_SECRET_KEY || '',
    stripePrice: e.STRIPE_PRICE_ID || '',
    priceCents: Number(e.PRICE_CENTS || 1490),
    currency: (e.PRICE_CURRENCY || 'brl').toLowerCase(),
    trialDays: Number(e.TRIAL_DAYS || 7),
    productName: e.PRODUCT_NAME || 'BloomFi Premium',
    pluggyId: e.PLUGGY_CLIENT_ID || '',
    pluggySecret: e.PLUGGY_CLIENT_SECRET || '',
    pluggySandbox: e.PLUGGY_SANDBOX === 'true',
    resendKey: e.RESEND_API_KEY || '',
    emailFrom: e.EMAIL_FROM || 'BloomFi <onboarding@resend.dev>',
    freeEmails: (e.FREE_ACCESS_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    stripeBase: e.STRIPE_API_BASE || 'https://api.stripe.com',
    pluggyBase: e.PLUGGY_API_BASE || 'https://api.pluggy.ai',
    resendBase: e.RESEND_API_BASE || 'https://api.resend.com',
    supportEmail: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.SUPPORT_EMAIL || '') ? e.SUPPORT_EMAIL.trim() : null,
    supportWhatsapp: (e.SUPPORT_WHATSAPP || '').replace(/\D/g, '') || null,
    vapidJwk: e.VAPID_PRIVATE_JWK || '',
    vapidSubject: e.VAPID_SUBJECT || (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.SUPPORT_EMAIL || '') ? `mailto:${e.SUPPORT_EMAIL.trim()}` : 'mailto:suporte@bloomfi.app'),
    pushAllowLocal: e.PUSH_ALLOW_LOCALHOST === '1',
  };
}

export class HttpError extends Error {
  constructor(status, code, detail) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

// ---------------- Stripe ----------------
/** Encodes nested objects the way Stripe expects: a[b][0][c]=1 */
function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(env, method, path, params) {
  if (!env.stripeKey) throw new HttpError(503, 'billing_not_configured');
  let url = `${env.stripeBase}/v1${path}`;
  const init = { method, headers: { Authorization: `Bearer ${env.stripeKey}` } };
  if (params && method === 'GET') url += `?${formEncode(params)}`;
  else if (params) {
    init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    init.body = formEncode(params).toString();
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'stripe_error', data?.error?.message);
  return data;
}

// ---------------- Pluggy ----------------
let pluggyKey = null; // { key, exp }

export async function pluggy(env, method, path, body) {
  if (!env.pluggyId || !env.pluggySecret) throw new HttpError(503, 'openfinance_not_configured');
  if (!pluggyKey || pluggyKey.exp < Date.now()) {
    const r = await fetch(`${env.pluggyBase}/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: env.pluggyId, clientSecret: env.pluggySecret }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.apiKey) throw new HttpError(502, 'pluggy_auth_failed');
    // API keys last 2 hours; renew a little earlier.
    pluggyKey = { key: d.apiKey, exp: Date.now() + 100 * 60 * 1000 };
  }
  const res = await fetch(`${env.pluggyBase}${path}`, {
    method,
    headers: { 'X-API-KEY': pluggyKey.key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) pluggyKey = null;
  if (method === 'DELETE' && res.ok) return { ok: true };
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, 'pluggy_error', data?.message);
  return data;
}

export function resetPluggyKey() { pluggyKey = null; }

// ---------------- E-mail (Resend) ----------------
export async function sendLoginCode(env, to, code) {
  if (!env.resendKey) throw new HttpError(503, 'email_not_configured');
  const html = `
    <div style="font-family:system-ui,Arial;max-width:420px;margin:auto;padding:24px;background:#14161b;color:#f6f8fb;border-radius:16px">
      <h2 style="margin:0 0 8px">BloomFi 🦉</h2>
      <p>Seu código para entrar:</p>
      <p style="font-size:34px;font-weight:800;letter-spacing:8px;color:#0bf28b;margin:12px 0">${code}</p>
      <p style="color:#9aa2b0;font-size:13px">Vale por 10 minutos. Se não foi você, ignore este e-mail.</p>
    </div>`;
  const res = await fetch(`${env.resendBase}/emails`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.resendKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.emailFrom, to: [to], subject: `Seu código BloomFi: ${code}`, html }),
  });
  if (!res.ok) throw new HttpError(502, 'email_failed');
}
