import React, { useEffect, useState } from 'react';
import { Delete, Fingerprint, ShieldCheck } from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from './Wally.jsx';
import { Confirm } from './Modal.jsx';

export function PinPad({ onComplete, error, length = 6, disabled = false, busy = false }) {
  const [pin, setPin] = useState('');
  const [shake, setShake] = useState(false);

  useEffect(() => {
    if (!error) return undefined;
    setShake(true);
    setPin('');
    const id = setTimeout(() => setShake(false), 400);
    return () => clearTimeout(id);
  }, [error]);

  const press = (d) => {
    if (disabled || busy) return;
    setPin((p) => {
      if (p.length >= length) return p;
      const next = p + d;
      if (next.length === length) setTimeout(() => { onComplete(next); setPin(''); }, 120);
      return next;
    });
  };

  useEffect(() => {
    const onKey = (e) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className={`pinpad ${disabled ? 'disabled' : ''}`}>
      <div className={`pin-dots ${shake ? 'shake' : ''} ${busy ? 'busy' : ''}`} aria-label={`${pin.length}/${length}`}>
        {Array.from({ length }).map((_, i) => <i key={i} className={i < pin.length ? 'on' : ''} />)}
      </div>
      {error && <p className="form-error center" role="alert">{error}</p>}
      <div className="keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((k, i) =>
          k === '' ? <span key={i} /> :
            k === 'del'
              ? <button key={i} type="button" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="delete"><Delete size={20} /></button>
              : <button key={i} type="button" onClick={() => press(k)} disabled={disabled}>{k}</button>
        )}
      </div>
    </div>
  );
}

export default function LockScreen() {
  const { unlock, unlockBiometric, t, settings, wipeAll, vaultInfo, guard } = useStore();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [wait, setWait] = useState(Math.max(0, (guard.until || 0) - Date.now()));
  const length = vaultInfo.enabled ? vaultInfo.pinLength : 4; // 4 = PIN from the previous version

  useEffect(() => {
    if (wait <= 0) return undefined;
    const id = setInterval(() => setWait((w) => Math.max(0, w - 1000)), 1000);
    return () => clearInterval(id);
  }, [wait > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  const tryBio = async () => {
    try {
      setBusy(true);
      if (!(await unlockBiometric())) setErr(t('sec.bioFail'));
    } catch {
      setErr(t('sec.bioFail'));
    } finally {
      setBusy(false);
    }
  };

  const onPin = async (p) => {
    setBusy(true);
    const r = await unlock(p);
    setBusy(false);
    if (r.ok) return;
    if (r.waitMs) { setWait(r.waitMs); setErr(t('pin.tooMany')); return; }
    setErr(`${t('pin.wrong')}${r.left ? ` · ${t('pin.left', { n: r.left })}` : ''}${'​'.repeat(Math.floor(Math.random() * 5))}`);
  };

  return (
    <div className="lock-screen">
      <Wally mood="thinking" size={70} />
      <h1>{settings.name ? t('pin.welcome', { name: settings.name }) : 'BloomFi'}</h1>
      <p className="sub">{wait > 0 ? t('pin.waitFor', { s: Math.ceil(wait / 1000) }) : busy ? t('pin.checking') : t('pin.enter')}</p>
      <PinPad length={length} error={err} disabled={wait > 0} busy={busy} onComplete={onPin} />
      {vaultInfo.bio && (
        <button className="bio-btn" onClick={tryBio} disabled={busy}><Fingerprint size={20} /> {t('sec.bioUnlock')}</button>
      )}
      {vaultInfo.enabled && <p className="lock-badge"><ShieldCheck size={13} /> {t('sec.encryptedBadge')}</p>}
      <button className="link-btn" onClick={() => setForgot(true)}>{t('pin.forgot')}</button>
      {forgot && (
        <Confirm title={t('pin.forgot')} text={t('pin.forgotText')} danger confirmLabel={t('set.wipeConfirm')} cancelLabel={t('common.cancel')}
          onClose={() => setForgot(false)} onConfirm={() => wipeAll()} />
      )}
    </div>
  );
}
