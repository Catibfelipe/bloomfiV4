import React, { useState } from 'react';
import { ArrowRight, ShieldCheck, Sparkles, WifiOff, Smartphone, ChevronLeft } from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from './Wally.jsx';
import { makeT } from '../i18n.js';
import { CURRENCIES, parseAmount } from '../lib/format.js';
import { priceLabel } from '../lib/billing.js';

export default function Onboarding() {
  const { settings, finishOnboarding, serverCfg } = useStore();
  const [step, setStep] = useState(0);
  const [lang, setLang] = useState(settings.lang);
  const [name, setName] = useState('');
  const [currency, setCurrency] = useState(settings.currency);
  const [income, setIncome] = useState('');
  const [balance, setBalance] = useState('');
  const [payday, setPayday] = useState(5);
  const [busy, setBusy] = useState(false);
  const t = makeT(lang);

  const finish = async (sample) => {
    setBusy(true);
    const inc = parseAmount(income, lang);
    const bal = balance.trim() ? parseAmount(balance, lang) : null;
    await finishOnboarding({ name, lang, currency, income: Number.isNaN(inc) ? 0 : inc, incomeDay: payday, balance: Number.isNaN(bal) ? null : bal, sample });
  };

  return (
    <div className="onboarding">
      <div className="onb-card">
        {step > 0 && <button className="onb-back" onClick={() => setStep(step - 1)} aria-label="back"><ChevronLeft size={20} /></button>}
        <div className="onb-dots">{[0, 1, 2].map((i) => <i key={i} className={i === step ? 'on' : ''} />)}</div>

        {step === 0 && (
          <>
            <Wally mood="celebrate" size={96} />
            <h1>{t('onb.hi')}</h1>
            <p className="sub">{t('onb.intro')}</p>
            <ul className="onb-feats">
              <li><ShieldCheck size={18} />{t('onb.f1')}</li>
              <li><WifiOff size={18} />{t('onb.f2')}</li>
              <li><Smartphone size={18} />{t('onb.f3')}</li>
            </ul>
            <div className="chips center">
              {[['pt', '🇧🇷 Português'], ['en', '🇺🇸 English']].map(([k, l]) => (
                <button key={k} className={lang === k ? 'on' : ''} onClick={() => { setLang(k); setCurrency(k === 'pt' ? 'BRL' : 'USD'); }}>{l}</button>
              ))}
            </div>
            <button className="primary full" onClick={() => setStep(1)}>{t('onb.start')} <ArrowRight size={18} /></button>
          </>
        )}

        {step === 1 && (
          <form className="form" onSubmit={(e) => { e.preventDefault(); setStep(2); }}>
            <Wally mood="happy" size={64} />
            <h1>{t('onb.nameQ')}</h1>
            <label>{t('set.name')}<input autoFocus value={name} maxLength={30} onChange={(e) => setName(e.target.value)} placeholder={t('onb.namePh')} /></label>
            <label>{t('set.currency')}
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <button className="primary full" type="submit">{t('common.next')} <ArrowRight size={18} /></button>
          </form>
        )}

        {step === 2 && (
          <div className="form">
            <Wally mood="thinking" size={64} />
            <h1>{t('onb.moneyQ')}</h1>
            <p className="sub">{t('onb.moneyHint')}</p>
            <label>{t('onb.balance')}<input className="amount" inputMode="decimal" placeholder="0,00" value={balance} onChange={(e) => setBalance(e.target.value)} /></label>
            <div className="form-2">
              <label>{t('onb.income')}<input inputMode="decimal" placeholder="0,00" value={income} onChange={(e) => setIncome(e.target.value)} /></label>
              <label>{t('onb.payday')}
                <select value={payday} onChange={(e) => setPayday(Number(e.target.value))}>
                  {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{t('card.dayN', { n: d })}</option>)}
                </select>
              </label>
            </div>
            <button className="primary full" disabled={busy} onClick={() => finish(false)}>{t('onb.go')} <ArrowRight size={18} /></button>
            <button className="secondary full" disabled={busy} onClick={() => finish(true)}><Sparkles size={16} /> {t('onb.sample')}</button>
            <p className="hint center">{t('onb.sampleHint')}</p>
            {serverCfg?.billing?.enabled && <p className="trial-note">{t('onb.trialNote', { n: serverCfg.billing.trialDays, p: priceLabel(serverCfg, lang) })}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
