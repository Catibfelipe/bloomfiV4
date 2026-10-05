import React, { useCallback, useEffect, useState } from 'react';
import {
  House, ReceiptText, PieChart, Target, Bot, Menu, X, Plus, Landmark, BarChart3, Settings as Cog, Lock, RefreshCw, TrendingUp, Eye, EyeOff,
  WalletCards, CalendarDays, Search,
} from 'lucide-react';
import Investments from './pages/Investments.jsx';
import { Paywall } from './components/Subscription.jsx';
import { useStore } from './store.jsx';
import Wally from './components/Wally.jsx';
import TxForm from './components/TxForm.jsx';
import Onboarding from './components/Onboarding.jsx';
import LockScreen from './components/Lock.jsx';
import CommandPalette from './components/CommandPalette.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Spend from './pages/Spend.jsx';
import Wallet from './pages/Wallet.jsx';
import Agenda from './pages/Agenda.jsx';
import Budgets from './pages/Budgets.jsx';
import Goals from './pages/Goals.jsx';
import Advisor from './pages/Advisor.jsx';
import Import from './pages/Import.jsx';
import Reports from './pages/Reports.jsx';
import Settings from './pages/Settings.jsx';
import { useSWUpdate } from './lib/sw.js';

const PAGES = {
  home: Dashboard, spend: Spend, wallet: Wallet, agenda: Agenda, invest: Investments, budget: Budgets, goals: Goals,
  ai: Advisor, import: Import, reports: Reports, settings: Settings,
};
const NAV = [
  ['home', House, 'nav.home'], ['spend', ReceiptText, 'nav.spend'], ['wallet', WalletCards, 'nav.wallet'], ['agenda', CalendarDays, 'nav.agenda'],
  ['invest', TrendingUp, 'nav.invest'], ['budget', PieChart, 'nav.budget'], ['goals', Target, 'nav.goals'], ['ai', Bot, 'nav.ai'],
  ['reports', BarChart3, 'nav.reports'], ['import', Landmark, 'nav.import'], ['settings', Cog, 'nav.settings'],
];
const BOTTOM = ['home', 'spend', 'wallet', 'invest', 'ai'];

function useRoute() {
  const read = () => { const p = window.location.hash.replace(/^#\/?/, ''); return PAGES[p] ? p : 'home'; };
  const [page, setPage] = useState(read);
  useEffect(() => {
    const on = () => { setPage(read()); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = useCallback((p) => { if (p !== read()) window.location.hash = p; else window.scrollTo({ top: 0, behavior: 'smooth' }); }, []);
  return [page, go];
}

function Brand({ t }) {
  return <div className="brand"><Wally size={34} /><div><strong>BloomFi</strong><span>{t('brand.tag')}</span></div></div>;
}

function Toast() {
  const { toastMsg, dismissToast } = useStore();
  if (!toastMsg) return null;
  return (
    <div key={toastMsg.id} className={`toast ${toastMsg.kind}`} role="status" aria-live="polite">
      <span>{toastMsg.text}</span>
      {toastMsg.action && <button onClick={() => { dismissToast(); toastMsg.action.run(); }}>{toastMsg.action.label}</button>}
    </div>
  );
}

export default function App() {
  const store = useStore();
  const { ready, settings, locked, t, txModal, openTx, lock, vaultInfo, entitlement, updateSettings, ledger } = store;
  const [page, go] = useRoute();
  const [menu, setMenu] = useState(false);
  const [palette, setPalette] = useState(false);
  const sw = useSWUpdate();
  const { closeTx } = store;
  useEffect(() => { closeTx(); setMenu(false); }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard: N = new transaction, Ctrl/Cmd+K or / = search
  useEffect(() => {
    const onKey = (e) => {
      const typing = /input|textarea|select/i.test(document.activeElement?.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); return; }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal, .cmd')) return;
      if (e.key === '/') { e.preventDefault(); setPalette(true); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); openTx({}); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openTx]);

  if (ready === 'error') return <div className="fatal"><Wally mood="worried" size={70} /><h1>{t('app.oops')}</h1><p>{t('app.dbError')}</p></div>;
  if (!ready) return <div className="splash"><Wally size={72} /></div>;
  if (!settings.onboarded) return <Onboarding />;
  if (locked) return <LockScreen />;
  if (!entitlement.canUse) return <><Paywall /><Toast /></>;
  const canLock = vaultInfo.enabled;
  const due = ledger.overdue + ledger.dueSoon;

  const Page = PAGES[page];
  const navBtn = ([key, Icon, label], onClick, short = false) => (
    <button key={key} className={page === key ? 'active' : ''} onClick={onClick || (() => go(key))} aria-current={page === key ? 'page' : undefined}>
      <Icon size={19} /><span>{t(short && key === 'wallet' ? 'nav.walletShort' : label)}</span>
      {key === 'agenda' && due > 0 && <em className={`count ${ledger.overdue ? 'late' : ''}`} aria-label={t('ag.countLabel', { n: due })}>{due}</em>}
    </button>
  );
  const eye = (
    <button className="icon-btn" onClick={() => updateSettings({ hideValues: !settings.hideValues })} aria-label={t('sec.hide')} title={t('sec.hide')}>
      {settings.hideValues ? <EyeOff size={18} /> : <Eye size={18} />}
    </button>
  );

  return (
    <div className="app">
      <a className="skip" href="#main">{t('app.skip')}</a>
      {/* Desktop / tablet sidebar */}
      <aside className="sidebar">
        <Brand t={t} />
        <button className="primary add-side" onClick={() => openTx({})}><Plus size={18} /> {t('tx.add')} <kbd>N</kbd></button>
        <button className="search-btn" onClick={() => setPalette(true)}><Search size={16} /> <span>{t('cmd.short')}</span> <kbd>{navigator.platform?.startsWith('Mac') ? '⌘K' : 'Ctrl K'}</kbd></button>
        <nav>{NAV.map((n) => navBtn(n))}</nav>
        <div className="side-foot">
          <button onClick={() => updateSettings({ hideValues: !settings.hideValues })}>{settings.hideValues ? <EyeOff size={17} /> : <Eye size={17} />} {settings.hideValues ? t('sec.show') : t('sec.hide')}</button>
          {canLock && <button onClick={() => lock()}><Lock size={17} /> {t('nav.lock')}</button>}
          <p>{t('app.local')}</p>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="topbar">
        <Brand t={t} />
        <div className="top-actions">
          <button className="icon-btn" onClick={() => setPalette(true)} aria-label={t('cmd.short')}><Search size={18} /></button>
          {eye}
          {canLock && <button className="icon-btn" onClick={() => lock()} aria-label={t('nav.lock')}><Lock size={18} /></button>}
          <button className={`icon-btn ${due > 0 ? `menu-dot ${ledger.overdue ? 'late' : ''}` : ''}`} onClick={() => setMenu(true)} aria-label="menu"><Menu size={20} /></button>
        </div>
      </header>

      <main id="main" className={`content page-${page}`} key={page}>
        <Page go={go} />
      </main>

      {/* Mobile bottom navigation */}
      <nav className="bottom-nav">
        {NAV.filter(([k]) => BOTTOM.includes(k)).map((n) => navBtn(n, undefined, true))}
      </nav>
      {page !== 'ai' && page !== 'import' && page !== 'settings' && (
        <button className="fab" onClick={() => openTx({})} aria-label={t('tx.add')}><Plus size={26} /></button>
      )}

      {/* Mobile drawer */}
      <div className={`drawer-wrap ${menu ? 'show' : ''}`} aria-hidden={!menu}>
        <div className="shade" onClick={() => setMenu(false)} />
        <div className="drawer">
          <div className="drawer-brand"><Brand t={t} /><button onClick={() => setMenu(false)} aria-label={t('common.close')}><X size={18} /></button></div>
          {NAV.map((n) => navBtn(n, () => { go(n[0]); setMenu(false); }))}
          {canLock && <button className="signout" onClick={() => { setMenu(false); lock(); }}><Lock size={18} /> {t('nav.lock')}</button>}
        </div>
      </div>

      {txModal && <TxForm key={txModal.id || `new-${txModal.type || ''}`} />}
      {palette && <CommandPalette nav={NAV} go={go} onClose={() => setPalette(false)} />}
      <Toast />
      {sw.needRefresh && (
        <div className="update-bar"><RefreshCw size={16} /> {t('app.update')}
          <button onClick={sw.update}>{t('app.updateBtn')}</button>
        </div>
      )}
    </div>
  );
}
