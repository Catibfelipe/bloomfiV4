import React, { useEffect, useState } from 'react';
import { Cloud, CloudOff, RefreshCw, Smartphone, Laptop, X, Trash2 } from 'lucide-react';
import Modal, { Confirm } from './Modal.jsx';
import { useStore } from '../store.jsx';

const errText = (t, e) => (t(`sync.err.${e?.code}`) !== `sync.err.${e?.code}` ? t(`sync.err.${e?.code}`) : t('sync.err.generic'));

/** Turn sync on: create the cloud copy (first device) or join it (other devices). */
export function SyncSetup({ onClose }) {
  const { t, cloudExists, cloudSetup, toast } = useStore();
  const [exists, setExists] = useState(null);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [mode, setMode] = useState('replace');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { cloudExists().then((r) => setExists(!!r?.exists)).catch((e) => { setExists(false); setError(errText(t, e)); }); }, []); // eslint-disable-line

  const submit = async (e) => {
    e.preventDefault();
    if (pw.length < 8) return setError(t('sync.errShort'));
    if (!exists && pw !== pw2) return setError(t('sync.errMatch'));
    setBusy(true); setError('');
    try {
      await cloudSetup(pw, exists ? mode : 'create');
      toast(exists ? t('sync.joined') : t('sync.created'));
      onClose();
    } catch (er) {
      setError(errText(t, er));
    }
    setBusy(false);
  };

  return (
    <Modal title={t('sync.setupTitle')} onClose={onClose}>
      {exists === null ? <p className="muted center">{t('sync.checking')}</p> : (
        <form className="form" onSubmit={submit}>
          <p className="confirm-text">{exists ? t('sync.joinText') : t('sync.createText')}</p>
          <label>{exists ? t('sync.password') : t('sync.newPassword')}
            <input type="password" autoComplete={exists ? 'current-password' : 'new-password'} autoFocus value={pw} onChange={(e) => { setPw(e.target.value); setError(''); }} />
          </label>
          {!exists && (
            <label>{t('sync.repeat')}<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => { setPw2(e.target.value); setError(''); }} /></label>
          )}
          {exists && (
            <div className="choice-list" role="radiogroup">
              <button type="button" role="radio" aria-checked={mode === 'replace'} className={mode === 'replace' ? 'on' : ''} onClick={() => setMode('replace')}>
                <b>{t('sync.modeReplace')}</b><small>{t('sync.modeReplaceHint')}</small>
              </button>
              <button type="button" role="radio" aria-checked={mode === 'merge'} className={mode === 'merge' ? 'on' : ''} onClick={() => setMode('merge')}>
                <b>{t('sync.modeMerge')}</b><small>{t('sync.modeMergeHint')}</small>
              </button>
            </div>
          )}
          <p className="hint">{t('sync.pwWarn')}</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="primary full" disabled={busy}>{busy ? t('sync.working') : exists ? t('sync.joinBtn') : t('sync.createBtn')}</button>
        </form>
      )}
    </Modal>
  );
}

export function SyncPanel() {
  const { t, lang, cloud, serverCfg, licensePayload, cloudSyncNow, cloudDisable, toast, isArtifact } = useStore();
  const [setup, setSetup] = useState(false);
  const [confirm, setConfirm] = useState(null);
  if (isArtifact || !serverCfg?.sync?.enabled) return null;
  const when = cloud.lastSyncAt ? new Intl.DateTimeFormat(lang === 'pt' ? 'pt-BR' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(cloud.lastSyncAt)) : null;
  return (
    <section className="panel sync-panel">
      <h3><Cloud size={17} /> {t('sync.title')}</h3>
      <div className="sync-devices" aria-hidden="true"><Smartphone size={22} /><i /><Cloud size={20} /><i /><Laptop size={22} /></div>
      {!licensePayload ? (
        <p className="muted">{t('sync.needsPlan')}</p>
      ) : !cloud.enabled ? (
        <>
          {cloud.error === 'cloud_deleted' && <p className="form-error" role="status">{t('sync.err.cloud_deleted')}</p>}
          <p className="muted">{t('sync.text')}</p>
          <button className="primary" onClick={() => setSetup(true)}><Cloud size={17} /> {t('sync.enable')}</button>
        </>
      ) : (
        <>
          <p className={`sync-status ${cloud.status}`}>
            {cloud.status === 'syncing' ? t('sync.syncing') : cloud.status === 'error' ? errText(t, { code: cloud.error }) : when ? t('sync.lastSync', { d: when }) : t('sync.on')}
          </p>
          <div className="btn-row wrap">
            <button className="secondary" disabled={cloud.status === 'syncing'} onClick={async () => { try { await cloudSyncNow(); toast(t('sync.done')); } catch (e) { toast(errText(t, e), 'err'); } }}>
              <RefreshCw size={16} className={cloud.status === 'syncing' ? 'spin' : ''} /> {t('sync.now')}
            </button>
            <button className="ghost" onClick={() => setConfirm('off')}><CloudOff size={16} /> {t('sync.disable')}</button>
          </div>
          <button className="link-btn danger" onClick={() => setConfirm('wipe')}><Trash2 size={14} /> {t('sync.wipe')}</button>
        </>
      )}
      {setup && <SyncSetup onClose={() => setSetup(false)} />}
      {confirm === 'off' && (
        <Confirm title={t('sync.disable')} text={t('sync.disableText')} confirmLabel={t('sync.disable')} cancelLabel={t('common.cancel')}
          onClose={() => setConfirm(null)} onConfirm={async () => { await cloudDisable(); toast(t('sync.disabled')); }} />
      )}
      {confirm === 'wipe' && (
        <Confirm title={t('sync.wipe')} text={t('sync.wipeText')} confirmLabel={t('sync.wipe')} cancelLabel={t('common.cancel')} danger
          onClose={() => setConfirm(null)} onConfirm={async () => { try { await cloudDisable({ wipeRemote: true }); toast(t('sync.wiped')); } catch (e) { toast(errText(t, e), 'err'); } }} />
      )}
    </section>
  );
}

/** Home banner on a new device: "we found your data from another device". */
export function RestoreBanner() {
  const { t, cloud, serverCfg, licensePayload, cloudExists, settings, updateSettings, isArtifact } = useStore();
  const [found, setFound] = useState(false);
  const [open, setOpen] = useState(false);
  const show = !isArtifact && serverCfg?.sync?.enabled && licensePayload && !cloud.enabled && !settings.dismissed?.restoreBanner;
  useEffect(() => {
    if (!show) return;
    cloudExists().then((r) => setFound(!!r?.exists)).catch(() => {});
  }, [show]); // eslint-disable-line
  if (!show || !found) return null;
  return (
    <section className="news restore">
      <Cloud size={22} />
      <div><b>{t('sync.foundTitle')}</b><p>{t('sync.foundText')}</p></div>
      <button className="secondary" onClick={() => setOpen(true)}>{t('sync.foundBtn')}</button>
      <button className="nudge-x" aria-label={t('common.dismiss')} onClick={() => updateSettings({ dismissed: { ...settings.dismissed, restoreBanner: true } })}><X size={14} /></button>
      {open && <SyncSetup onClose={() => setOpen(false)} />}
    </section>
  );
}
