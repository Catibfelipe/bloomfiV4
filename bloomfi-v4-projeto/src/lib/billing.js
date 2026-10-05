/**
 * Subscription on the device side.
 *
 * The server signs a license (ES256) saying "this person has paid until X".
 * The app checks that signature offline with the public key, so a paying
 * user keeps working without internet until the license expires, and the
 * app locks (paywall) when it does. Data export is always allowed.
 */
import { db } from '../db.js';

export const IS_ARTIFACT = import.meta.env.VITE_ARTIFACT === '1';
const API = import.meta.env.VITE_API_BASE || '/api';
const DAY = 86400000;

export async function api(path, { method = 'GET', body, token, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${API}/${path}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    const isJSON = (res.headers.get('content-type') || '').includes('application/json');
    const data = isJSON ? await res.json().catch(() => ({})) : null;
    if (!res.ok || !isJSON) {
      const err = new Error(data?.error || `http_${res.status}`);
      err.code = data?.error || (isJSON ? `http_${res.status}` : 'no_server');
      err.status = res.status;
      throw err;
    }
    return data;
  } catch (e) {
    if (!e.code) e.code = 'offline';
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** Reads /api/config. null = no server (static hosting): the app is free. */
export async function loadServerConfig() {
  if (IS_ARTIFACT) return null;
  const cached = (await db.getMeta('serverConfig')) || null;
  try {
    const cfg = await api('config', { timeout: 7000 });
    if (cfg?.billing) { await db.setMeta('serverConfig', cfg); return cfg; }
  } catch (e) {
    // Offline: keep the last known configuration (so the paywall can't be skipped by going offline).
    if (e.code === 'offline') return cached;
    // No server at all and billing was never seen on this device: free mode.
    if ((e.code === 'no_server' || e.status === 404) && !cached?.billing?.enabled) return null;
  }
  return cached;
}

const b64urlDecode = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** Verifies the ES256 signature; returns the payload (expiry checked by the caller). */
export async function verifyLicense(token, jwk) {
  try {
    if (!token || !jwk) return null;
    const [h, p, s] = token.split('.');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    return JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    return null;
  }
}

export function computeEntitlement({ cfg, license, trialStart, hadAccount = false, now = Date.now() }) {
  if (!cfg?.billing?.enabled) return { status: 'free', canUse: true };
  const trialDays = cfg.billing.trialDays ?? 7;
  if (license && license.exp * 1000 > now) {
    return {
      status: 'active', canUse: true, license, email: license.email, kind: license.status,
      renews: !!license.renews, periodEnd: license.periodEnd ? license.periodEnd * 1000 : license.exp * 1000,
    };
  }
  const start = trialStart ?? now;
  const trialEnd = start + trialDays * DAY;
  const had = !!license || hadAccount;
  if (now < trialEnd && !had) return { status: 'trial', canUse: true, daysLeft: Math.max(1, Math.ceil((trialEnd - now) / DAY)), trialEnd, hadLicense: false };
  return { status: 'expired', canUse: false, hadLicense: had, email: license?.email };
}

export function priceLabel(cfg, lang) {
  const b = cfg?.billing;
  if (!b) return '';
  return new Intl.NumberFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { style: 'currency', currency: (b.currency || 'brl').toUpperCase() }).format((b.price || 0) / 100);
}

/** Reads ?checkout=success&session_id=... left by Stripe, then cleans the URL. */
export function takeCheckoutReturn() {
  const q = new URLSearchParams(window.location.search);
  const state = q.get('checkout');
  if (!state) return null;
  const sessionId = q.get('session_id');
  const clean = window.location.pathname + window.location.hash;
  window.history.replaceState(null, '', clean);
  return { state, sessionId };
}
