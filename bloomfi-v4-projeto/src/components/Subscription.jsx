import React, { useState } from 'react';
import {
  Crown, Check, Mail, KeyRound, Download, LogIn, RefreshCw, ExternalLink, Clock, LogOut, Sparkles,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from './Wally.jsx';
import Modal from './Modal.jsx';
import { priceLabel } from '../lib/billing.js';
import { SupportLine } from './Support.jsx';
import { download } from '../lib/pwa.js';
import { todayISO } from '../lib/dates.js';
import { formatDate } from '../lib/format.js';

const errText = (t, e) => t(`bill.err.${e?.code}`) !== `bill.err.${e?.code}` ? t(`bill.err.${e?.code}`) : t('bill.err.generic');

export function SubscribeModal({ onClose }) {
  const { t, startCheckout, account, entitlement, serverCfg, lang } = useStore();
  const [email, setEmail] = useState(account?.email || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await startCheckout(email.trim()); } catch (er) { setError(errText(t, er)); setBusy(false); }
  };
  return (
    <Modal title={t('bill.subscribeTitle')} onClose={onClose}>
      <form className="form" onSubmit={go}>
        <p className="price-big">{priceLabel(serverCfg, lang)}<small>/{t('bill.month')}</small></p>
        {entitlement.status === 'trial' && <p className="hint center">{t('bill.keepTrial', { n: entitlement.daysLeft })}</p>}
        <label>{t('bill.email')}<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@email.com" /></label>
        <p className="hint">{t('bill.emailHint')}</p>
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" disabled={busy}>{busy ? t('bill.opening') : t('bill.goPay')}</button>
        <p className="hint center">{t('bill.stripeNote')}</p>
      </form>
    </Modal>
  );
}

export function LoginModal({ onClose }) {
  const { t, loginStart, loginVerify, toast, serverCfg } = useStore();
  const [email, setEmail] = useState('');
  const [challenge, setChallenge] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  if (!serverCfg?.emailLogin) {
    return (
      <Modal title={t('bill.loginTitle')} onClose={onClose}>
        <p className="confirm-text">{t('bill.loginUnavailable')}</p>
        <button className="primary full" onClick={onClose}>{t('common.ok')}</button>
      </Modal>
    );
  }

  const start = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { const r = await loginStart(email.trim()); setChallenge(r.challenge); } catch (er) { setError(errText(t, er)); }
    setBusy(false);
  };
  const verify = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await loginVerify(challenge, code);
      if (r.license) { toast(t('bill.restored')); onClose(); } else setResult(r);
    } catch (er) { setError(errText(t, er)); }
    setBusy(false);
  };

  return (
    <Modal title={t('bill.loginTitle')} onClose={onClose}>
      {result ? (
        <>
          <p className="confirm-text">{t('bill.noSubFound', { e: result.email })}</p>
          <button className="primary full" onClick={onClose}>{t('common.ok')}</button>
        </>
      ) : !challenge ? (
        <form className="form" onSubmit={start}>
          <p className="hint">{t('bill.loginHint')}</p>
          <label>{t('bill.email')}<input type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary full" disabled={busy}><Mail size={17} /> {t('bill.sendCode')}</button>
        </form>
      ) : (
        <form className="form" onSubmit={verify}>
          <p className="hint">{t('bill.codeSent', { e: email })}</p>
          <label>{t('bill.code')}<input className="amount code-input" inputMode="numeric" autoComplete="one-time-code" autoFocus maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} /></label>
          {error && <p className="form-error">{error}</p>}
          <button className="primary full" disabled={busy || code.length !== 6}><LogIn size={17} /> {t('bill.enter')}</button>
          <button type="button" className="link-btn" onClick={() => { setChallenge(null); setCode(''); }}>{t('bill.otherEmail')}</button>
        </form>
      )}
    </Modal>
  );
}

export function AccessCodeModal({ onClose }) {
  const { t, redeemAccessCode, toast } = useStore();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try { await redeemAccessCode(code); toast(t('bill.codeOk')); onClose(); } catch (er) { setError(er.code === 'invalid_account' ? t('bill.codeBad') : errText(t, er)); }
    setBusy(false);
  };
  return (
    <Modal title={t('bill.accessCode')} onClose={onClose}>
      <form className="form" onSubmit={go}>
        <p className="hint">{t('bill.accessHint')}</p>
        <textarea id="bf-access-code" className="textbox short" required value={code} onChange={(e) => setCode(e.target.value)} placeholder="eyJ…" />
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" disabled={busy || code.trim().length < 20}><KeyRound size={17} /> {t('bill.activate')}</button>
      </form>
    </Modal>
  );
}

/** Full screen shown when the trial or subscription has ended. Backup always works. */
export function Paywall() {
  const { t, entitlement, serverCfg, lang, exportBackup, updateSettings, toast, refreshLicense, account } = useStore();
  const [modal, setModal] = useState(null);
  const [checking, setChecking] = useState(false);
  const backup = async () => {
    const data = await exportBackup();
    download(`bloomfi-backup-${todayISO()}.json`, JSON.stringify(data, null, 2));
    await updateSettings({ lastBackup: todayISO() });
    toast(t('set.backupDone'));
  };
  const recheck = async () => {
    setChecking(true);
    const r = await refreshLicense({ force: true });
    setChecking(false);
    if (!r?.license) toast(t('bill.stillExpired'), 'info');
  };
  const perks = ['bill.perk1', 'bill.perk2', 'bill.perk3', 'bill.perk4', 'bill.perk5'];
  return (
    <div className="paywall">
      <div className="paywall-card">
        <Wally mood="sleep" size={72} />
        <h1>{entitlement.hadLicense ? t('bill.expiredTitle') : t('bill.trialOverTitle')}</h1>
        <p className="sub">{t('bill.expiredSub')}</p>
        <ul className="perks">{perks.map((p) => <li key={p}><Check size={16} /> {t(p)}</li>)}</ul>
        <p className="price-big">{priceLabel(serverCfg, lang)}<small>/{t('bill.month')}</small></p>
        <button className="primary full" onClick={() => setModal('subscribe')}><Crown size={18} /> {entitlement.hadLicense ? t('bill.renew') : t('bill.subscribe')}</button>
        <div className="paywall-links">
          <button className="secondary" onClick={() => setModal('login')}><LogIn size={16} /> {t('bill.haveAccount')}</button>
          <button className="secondary" onClick={() => setModal('code')}><KeyRound size={16} /> {t('bill.accessCode')}</button>
          {account && <button className="secondary" onClick={recheck} disabled={checking}><RefreshCw size={16} /> {t('bill.recheck')}</button>}
        </div>
        <div className="paywall-data">
          <p>{t('bill.dataSafe')}</p>
          <button className="ghost" onClick={backup}><Download size={16} /> {t('set.backup')}</button>
        </div>
        <SupportLine />
        <p className="legal-links"><a href="/termos.html" target="_blank" rel="noopener">{t('legal.terms')}</a> · <a href="/privacidade.html" target="_blank" rel="noopener">{t('legal.privacy')}</a></p>
      </div>
      {modal === 'subscribe' && <SubscribeModal onClose={() => setModal(null)} />}
      {modal === 'login' && <LoginModal onClose={() => setModal(null)} />}
      {modal === 'code' && <AccessCodeModal onClose={() => setModal(null)} />}
    </div>
  );
}

export function TrialBanner() {
  const { t, entitlement, serverCfg, lang } = useStore();
  const [open, setOpen] = useState(false);
  if (entitlement.status !== 'trial') return null;
  return (
    <>
      <button className={`trial-banner ${entitlement.daysLeft <= 2 ? 'urgent' : ''}`} onClick={() => setOpen(true)}>
        <Clock size={16} />
        <span>{t('bill.trialLeft', { n: entitlement.daysLeft })}</span>
        <b>{t('bill.subscribeFor', { p: priceLabel(serverCfg, lang) })}</b>
      </button>
      {open && <SubscribeModal onClose={() => setOpen(false)} />}
    </>
  );
}

export function SubscriptionPanel() {
  const { t, entitlement, serverCfg, lang, account, openPortal, refreshLicense, forgetAccount, toast } = useStore();
  const [modal, setModal] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!serverCfg?.billing?.enabled) return null;
  const e = entitlement;
  const portal = async () => { setBusy(true); try { await openPortal(); } catch (er) { toast(errText(t, er), 'err'); setBusy(false); } };
  const recheck = async () => { setBusy(true); const r = await refreshLicense({ force: true }); setBusy(false); toast(r?.license ? t('bill.updated') : t('bill.checkFailed'), r?.license ? 'ok' : 'info'); };
  return (
    <section className="panel sub-panel">
      <h3><Crown size={17} /> {t('bill.title')}</h3>
      {e.status === 'active' && (
        <>
          <p className="sub-status ok"><Sparkles size={15} /> {e.kind === 'free' || e.kind === 'gift' ? t('bill.giftActive') : e.kind === 'trialing' ? t('bill.activeTrial') : e.kind === 'past_due' ? t('bill.pastDue') : t('bill.active')}</p>
          <p className="muted">{e.email}</p>
          <p className="muted">{e.renews ? t('bill.renewsOn', { d: formatDate(new Date(e.periodEnd).toISOString().slice(0, 10), lang) }) : t('bill.endsOn', { d: formatDate(new Date(e.periodEnd).toISOString().slice(0, 10), lang) })}</p>
          <div className="btn-row wrap">
            {account && !['free', 'gift'].includes(e.kind) && <button className="secondary" onClick={portal} disabled={busy}><ExternalLink size={16} /> {t('bill.manage')}</button>}
            <button className="ghost" onClick={recheck} disabled={busy}><RefreshCw size={15} /> {t('bill.recheck')}</button>
          </div>
          <button className="link-btn left" onClick={forgetAccount}><LogOut size={13} /> {t('bill.forget')}</button>
        </>
      )}
      {e.status === 'trial' && (
        <>
          <p className="sub-status">{t('bill.trialLeft', { n: e.daysLeft })}</p>
          <p className="muted">{t('bill.trialText', { p: priceLabel(serverCfg, lang) })}</p>
          <button className="primary" onClick={() => setModal('subscribe')}><Crown size={17} /> {t('bill.subscribe')}</button>
          <div className="btn-row wrap">
            <button className="ghost" onClick={() => setModal('login')}><LogIn size={15} /> {t('bill.haveAccount')}</button>
            <button className="ghost" onClick={() => setModal('code')}><KeyRound size={15} /> {t('bill.accessCode')}</button>
          </div>
        </>
      )}
      <p className="legal-links left"><a href="/termos.html" target="_blank" rel="noopener">{t('legal.terms')}</a> · <a href="/privacidade.html" target="_blank" rel="noopener">{t('legal.privacy')}</a></p>
      {modal === 'subscribe' && <SubscribeModal onClose={() => setModal(null)} />}
      {modal === 'login' && <LoginModal onClose={() => setModal(null)} />}
      {modal === 'code' && <AccessCodeModal onClose={() => setModal(null)} />}
    </section>
  );
}
