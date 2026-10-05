import React, { useEffect, useRef, useState } from 'react';
import {
  User, Globe, Lock, Download, Upload, FileSpreadsheet, Trash2, Smartphone, Database, ShieldCheck, Sparkles, Share, SquarePlus, Monitor,
  Fingerprint, EyeOff, Timer, KeyRound, Landmark, Tags,
} from 'lucide-react';
import { useStore } from '../store.jsx';
import { PageHead } from '../components/Common.jsx';
import Modal, { Confirm } from '../components/Modal.jsx';
import { PinPad } from '../components/Lock.jsx';
import { SubscriptionPanel } from '../components/Subscription.jsx';
import { CategoryManager } from '../components/Categories.jsx';
import { SupportPanel } from '../components/Support.jsx';
import { SyncPanel } from '../components/CloudSync.jsx';
import { RemindersPanel } from '../components/Reminders.jsx';
import { CURRENCIES } from '../lib/format.js';
import { storageInfo, requestPersistence } from '../db.js';
import { useInstall, download } from '../lib/pwa.js';
import { biometricAvailable } from '../lib/biometric.js';
import { todayISO } from '../lib/dates.js';

const AUTO_LOCK = [0, 1, 5, 15, -1];

export default function Settings({ go }) {
  const s = useStore();
  const { settings, t, updateSettings, toast, txs, vaultInfo, isArtifact } = s;
  const [name, setName] = useState(settings.name);
  const [info, setInfo] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [pinOpen, setPinOpen] = useState(false);
  const [installHelp, setInstallHelp] = useState(false);
  const [textBox, setTextBox] = useState(null);
  const [backupAsk, setBackupAsk] = useState(false);
  const [restorePw, setRestorePw] = useState(null);
  const [bioOk, setBioOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);
  const fileRef = useRef();
  const install = useInstall();

  useEffect(() => { storageInfo().then(setInfo); }, [txs.length]);
  useEffect(() => { setName(settings.name); }, [settings.name]);
  useEffect(() => { if (!isArtifact) biometricAvailable().then(setBioOk); }, [isArtifact]);

  const doExport = async (password) => {
    const data = await s.exportBackup(password || undefined);
    if (isArtifact) setTextBox({ mode: 'export', title: t('set.backup'), text: JSON.stringify(data) });
    else { download(`bloomfi-backup-${todayISO()}${password ? '-protegido' : ''}.json`, JSON.stringify(data, null, password ? 0 : 2)); toast(t('set.backupDone')); }
    await updateSettings({ lastBackup: todayISO() });
  };

  const exportCSV = () => {
    const head = ['date', 'type', 'amount', 'category', 'description'];
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [...txs].sort((a, b) => a.date.localeCompare(b.date))
      .map((x) => [x.date, x.type, x.amount.toFixed(2), t(`cat.${x.category}`), x.description].map(esc).join(','));
    const csv = [head.join(','), ...rows].join('\n');
    if (isArtifact) setTextBox({ mode: 'export', title: t('set.csv'), text: csv });
    else download(`bloomfi-${todayISO()}.csv`, '﻿' + csv, 'text/csv;charset=utf-8');
  };

  const askRestore = (plain) => setConfirm({
    title: t('set.restoreTitle'), text: t('set.restoreText', { n: (plain.transactions || []).length }), danger: true,
    label: t('set.restore'), run: async () => { await s.restoreBackup(plain); toast(t('set.restored')); },
  });
  const restoreText = (raw) => {
    try {
      const data = JSON.parse(raw);
      if (data?.app !== 'BloomFi') throw new Error('bad');
      if (data.encrypted) setRestorePw(data); else askRestore(data);
    } catch { toast(t('set.restoreErr'), 'err'); }
  };

  const toggleBio = async () => {
    setBusy(true);
    try {
      if (vaultInfo.bio) { await s.disableBiometric(); toast(t('sec.bioOff')); }
      else { await s.enableBiometric(); toast(t('sec.bioOn')); }
    } catch (e) {
      toast(e.code === 'prf-unsupported' ? t('sec.bioUnsupported') : t('sec.bioFail'), 'err');
    }
    setBusy(false);
  };

  const mb = (b) => (b / 1024 / 1024).toFixed(b > 1024 * 1024 ? 1 : 2);

  return (
    <div className="page settings">
      <PageHead title={t('set.title')} sub={t('set.sub')} />

      <div className="two-col">
        <div>
          <SubscriptionPanel />

          <SyncPanel />

          <section className="panel sec-panel">
            <h3><ShieldCheck size={17} /> {t('set.security')}</h3>
            <div className={`sec-status ${vaultInfo.enabled ? 'on' : ''}`}>
              <Lock size={18} />
              <div>
                <b>{vaultInfo.enabled ? t('sec.encOn') : t('sec.encOff')}</b>
                <span>{vaultInfo.enabled ? t('sec.encOnText') : t('sec.encOffText')}</span>
              </div>
            </div>
            <div className="btn-row wrap">
              <button className={vaultInfo.enabled ? 'secondary' : 'primary'} onClick={() => setPinOpen(true)}>
                <KeyRound size={16} /> {vaultInfo.enabled ? t('set.pinChange') : t('sec.enable')}
              </button>
              {vaultInfo.enabled && <button className="ghost" onClick={() => setConfirm({ title: t('sec.disable'), text: t('sec.disableText'), label: t('sec.disable'), danger: true, run: async () => { await s.removePin(); toast(t('set.pinRemoved')); } })}>{t('sec.disable')}</button>}
            </div>

            {vaultInfo.enabled && bioOk && (
              <button className={`toggle ${vaultInfo.bio ? 'on' : ''}`} onClick={toggleBio} disabled={busy} aria-pressed={vaultInfo.bio}>
                <span><Fingerprint size={16} /> {t('sec.bio')}<small>{t('sec.bioHint')}</small></span><i />
              </button>
            )}

            {vaultInfo.enabled && (
              <label className="field"><span className="field-label"><Timer size={14} /> {t('sec.autoLock')}</span>
                <select value={settings.autoLockMin} onChange={(e) => updateSettings({ autoLockMin: Number(e.target.value) })}>
                  {AUTO_LOCK.map((m) => <option key={m} value={m}>{t(`sec.lock.${m}`)}</option>)}
                </select>
              </label>
            )}

            <button className={`toggle ${settings.hideValues ? 'on' : ''}`} onClick={() => updateSettings({ hideValues: !settings.hideValues })} aria-pressed={settings.hideValues}>
              <span><EyeOff size={16} /> {t('sec.hide')}<small>{t('sec.hideHint')}</small></span><i />
            </button>
          </section>

          <section className="panel">
            <h3><User size={17} /> {t('set.profile')}</h3>
            <div className="field">{t('set.name')}
              <div className="inline-input">
                <input aria-label={t('set.name')} value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder={t('onb.namePh')} />
                <button className="secondary" disabled={name === settings.name} onClick={() => { updateSettings({ name: name.trim() }); toast(t('set.saved')); }}>{t('common.save')}</button>
              </div>
            </div>
            <div className="field" role="group" aria-label={t('set.language')}>{t('set.language')}
              <div className="chips">
                {[['pt', 'Português'], ['en', 'English']].map(([k, l]) => (
                  <button key={k} className={settings.lang === k ? 'on' : ''} onClick={() => updateSettings({ lang: k })}>{l}</button>
                ))}
              </div>
            </div>
            <label className="field">{t('set.currency')}
              <select value={settings.currency} onChange={(e) => updateSettings({ currency: e.target.value })}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <div className="field" role="group" aria-label={t('set.textSize')}>{t('set.textSize')}
              <div className="chips">
                {['normal', 'large', 'xlarge'].map((k) => (
                  <button key={k} className={(settings.textSize || 'normal') === k ? 'on' : ''} onClick={() => updateSettings({ textSize: k })} aria-pressed={(settings.textSize || 'normal') === k}>
                    <span className={`aa aa-${k}`}>A</span> {t(`set.textSize.${k}`)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <h3><Tags size={17} /> {t('cats.title')}</h3>
            <p className="muted">{t('cats.panelText', { n: s.categories.length })}</p>
            <button className="secondary full" onClick={() => setCatsOpen(true)}><Tags size={16} /> {t('cats.manage')}</button>
          </section>


          {!isArtifact && <section className="panel">
            <h3><Smartphone size={17} /> {t('set.install')}</h3>
            {install.installed ? <p className="muted">✅ {t('set.installed')}</p> : (
              <>
                <p className="muted">{t('set.installText')}</p>
                <button className="primary" onClick={async () => { if (install.canPrompt) { if (await install.prompt()) toast(t('set.installedNow')); } else setInstallHelp(true); }}>
                  <Download size={18} /> {t('set.installBtn')}
                </button>
              </>
            )}
          </section>}
        </div>

        <div>
          <section className="panel">
            <h3><Database size={17} /> {t('set.data')}</h3>
            <p className="muted">{t('set.dataText')}</p>
            {info && (
              <div className="storage-box">
                <div><span>{t('set.records')}</span><b>{txs.length}</b></div>
                <div><span>{t('set.used')}</span><b>{mb(info.usage)} MB</b></div>
                <div>
                  <span>{t('set.protected')}</span>
                  <b className={info.persisted ? 'positive' : 'warn-text'}>{info.persisted ? t('common.yes') : t('common.no')}</b>
                </div>
              </div>
            )}
            {info && !info.persisted && (
              <button className="ghost small" onClick={async () => { const ok = await requestPersistence(); setInfo(await storageInfo()); toast(ok ? t('set.persistOk') : t('set.persistNo'), ok ? 'ok' : 'info'); }}>
                <ShieldCheck size={15} /> {t('set.persist')}
              </button>
            )}
            <p className="hint">{settings.lastBackup ? t('set.lastBackup', { d: settings.lastBackup.split('-').reverse().join('/') }) : t('set.noBackup')}</p>
            <div className="data-actions">
              <button className="primary" onClick={() => setBackupAsk(true)}><Download size={17} /> {t('set.backup')}</button>
              <button className="secondary" onClick={() => (isArtifact ? setTextBox({ mode: 'import', title: t('set.restore'), text: '' }) : fileRef.current?.click())}><Upload size={17} /> {t('set.restore')}</button>
              <button className="secondary" onClick={exportCSV} disabled={!txs.length}><FileSpreadsheet size={17} /> {t('set.csv')}</button>
              <button className="secondary" onClick={() => go('import')}><Landmark size={17} /> {t('nav.import')}</button>
              <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) restoreText(await f.text()); }} />
            </div>
          </section>

          <RemindersPanel />

          <SupportPanel />

          <section className="panel danger-zone">
            <h3><Trash2 size={17} /> {t('set.danger')}</h3>
            {s.hasSample && (
              <button className="secondary" onClick={() => setConfirm({ title: t('set.sampleRemove'), text: t('set.sampleText'), label: t('set.sampleRemove'), run: async () => { await s.removeSample(); toast(t('set.sampleRemoved')); } })}>
                <Sparkles size={16} /> {t('set.sampleRemove')}
              </button>
            )}
            <button className="danger-btn" onClick={() => setConfirm({ title: t('set.wipe'), text: t('set.wipeText'), danger: true, label: t('set.wipeConfirm'), run: async () => { await s.wipeAll(); } })}>
              {t('set.wipe')}
            </button>
          </section>

          <p className="about">BloomFi 4.1 · {t('set.about')}
            {!isArtifact && <><br /><a href="/termos.html" target="_blank" rel="noopener">{t('legal.terms')}</a> · <a href="/privacidade.html" target="_blank" rel="noopener">{t('legal.privacy')}</a></>}
          </p>
        </div>
      </div>

      {catsOpen && <CategoryManager onClose={() => setCatsOpen(false)} />}
      {confirm && (
        <Confirm title={confirm.title} text={confirm.text} confirmLabel={confirm.label} cancelLabel={t('common.cancel')} danger={confirm.danger}
          onClose={() => setConfirm(null)} onConfirm={confirm.run} />
      )}
      {pinOpen && <PinSetup onClose={() => setPinOpen(false)} />}
      {backupAsk && <BackupModal onClose={() => setBackupAsk(false)} onExport={doExport} />}
      {restorePw && <RestorePassword box={restorePw} onClose={() => setRestorePw(null)} onPlain={(plain) => { setRestorePw(null); askRestore(plain); }} />}
      {textBox && <TextBox box={textBox} onClose={() => setTextBox(null)} onFile={() => { setTextBox(null); fileRef.current?.click(); }}
        onRestore={(txt) => { setTextBox(null); restoreText(txt); }} />}
      {installHelp && <InstallHelp platform={install.platform} onClose={() => setInstallHelp(false)} />}
    </div>
  );
}

function PinSetup({ onClose }) {
  const { t, setPin, toast, vaultInfo } = useStore();
  const [first, setFirst] = useState(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={first ? t('pin.confirm') : vaultInfo.enabled ? t('pin.newChange') : t('pin.new')} onClose={busy ? () => {} : onClose}>
      <PinPad key={first ? 'b' : 'a'} length={6} error={err} busy={busy} onComplete={async (p) => {
        if (!first) {
          if (/^(\d)\1{5}$/.test(p) || '0123456789'.includes(p) || '9876543210'.includes(p)) { setErr(t('pin.weak')); return; }
          setFirst(p); setErr(''); return;
        }
        if (p !== first) { setFirst(null); setErr(t('pin.mismatch')); return; }
        setBusy(true);
        await setPin(p);
        toast(t('pin.saved'));
        onClose();
      }} />
      <p className="hint center">{busy ? t('sec.encrypting') : t('pin.hint')}</p>
    </Modal>
  );
}

function BackupModal({ onClose, onExport }) {
  const { t } = useStore();
  const [protect, setProtect] = useState(true);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault();
    if (protect && pw.length < 6) return setError(t('sec.pwShort'));
    if (protect && pw !== pw2) return setError(t('sec.pwMismatch'));
    setBusy(true);
    await onExport(protect ? pw : null);
    onClose();
  };
  return (
    <Modal title={t('set.backup')} onClose={onClose}>
      <form className="form" onSubmit={go}>
        <button type="button" className={`toggle ${protect ? 'on' : ''}`} onClick={() => setProtect(!protect)} aria-pressed={protect}>
          <span><Lock size={16} /> {t('sec.backupProtect')}<small>{t('sec.backupProtectHint')}</small></span><i />
        </button>
        {protect && (
          <>
            <label>{t('sec.password')}<input type="password" autoComplete="new-password" value={pw} onChange={(e) => { setPw(e.target.value); setError(''); }} /></label>
            <label>{t('sec.password2')}<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => { setPw2(e.target.value); setError(''); }} /></label>
            <p className="hint">{t('sec.pwWarn')}</p>
          </>
        )}
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" disabled={busy}><Download size={17} /> {busy ? t('sec.encrypting') : t('set.backup')}</button>
      </form>
    </Modal>
  );
}

function RestorePassword({ box, onClose, onPlain }) {
  const { t, readBackup } = useStore();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async (e) => {
    e.preventDefault();
    setBusy(true);
    try { onPlain(await readBackup(box, pw)); } catch { setError(t('sec.pwWrong')); setBusy(false); }
  };
  return (
    <Modal title={t('set.restore')} onClose={onClose}>
      <form className="form" onSubmit={go}>
        <p className="hint">{t('sec.backupLocked')}</p>
        <label>{t('sec.password')}<input type="password" autoFocus value={pw} onChange={(e) => { setPw(e.target.value); setError(''); }} /></label>
        {error && <p className="form-error">{error}</p>}
        <button className="primary full" disabled={busy || !pw}>{busy ? t('pin.checking') : t('set.restore')}</button>
      </form>
    </Modal>
  );
}

export function InstallHelp({ platform, onClose }) {
  const { t } = useStore();
  const steps = platform === 'ios'
    ? [[Share, t('inst.ios1')], [SquarePlus, t('inst.ios2')], [Smartphone, t('inst.ios3')]]
    : platform === 'android'
      ? [[Globe, t('inst.and1')], [Download, t('inst.and2')], [Smartphone, t('inst.and3')]]
      : [[Monitor, t('inst.pc1')], [Download, t('inst.pc2')], [Smartphone, t('inst.pc3')]];
  return (
    <Modal title={t('inst.title')} onClose={onClose}>
      <ol className="install-steps">
        {steps.map(([Icon, text], i) => <li key={i}><div className="cat-icon" style={{ '--c': '#0bf28b' }}><Icon size={18} /></div><span>{text}</span></li>)}
      </ol>
      <button className="primary full" onClick={onClose}>{t('common.ok')}</button>
    </Modal>
  );
}

function TextBox({ box, onClose, onRestore, onFile }) {
  const { t, toast } = useStore();
  const [text, setText] = useState(box.text);
  const ref = useRef();
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); toast(t('set.copied')); }
    catch { ref.current?.select(); toast(t('set.copyManual'), 'info'); }
  };
  return (
    <Modal title={box.title} onClose={onClose}>
      <p className="hint">{box.mode === 'export' ? t('set.copyHint') : t('set.pasteHint')}</p>
      <textarea id="bf-textbox" ref={ref} className="textbox" value={text} readOnly={box.mode === 'export'}
        onFocus={(e) => box.mode === 'export' && e.target.select()} onChange={(e) => setText(e.target.value)} />
      {box.mode === 'export'
        ? <button className="primary full" onClick={copy}>{t('set.copy')}</button>
        : <div className="btn-row">
            <button className="secondary" onClick={onFile}>{t('set.fromFile')}</button>
            <button className="primary" disabled={!text.trim()} onClick={() => onRestore(text)}>{t('set.restore')}</button>
          </div>}
    </Modal>
  );
}
