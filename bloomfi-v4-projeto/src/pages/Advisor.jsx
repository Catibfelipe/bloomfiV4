import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Send, Eraser, ShieldCheck } from 'lucide-react';
import { useStore } from '../store.jsx';
import Wally from '../components/Wally.jsx';
import { analyze, wallyMood } from '../lib/finance.js';
import { wallyReply, advisorPrompts } from '../lib/advisor.js';
import { currentMonth } from '../lib/dates.js';
import { monthProjection } from '../lib/ledger.js';

export default function Advisor() {
  const store = useStore();
  const { txs, budgets, goals, assets, chat, addChat, clearChat, t, lang, money, settings, ledger, accounts, cards } = store;
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const endRef = useRef();
  const a = useMemo(() => analyze({ txs, budgets, goals }, currentMonth()), [txs, budgets, goals]);
  const mood = typing ? 'thinking' : wallyMood(a, a.sum.count > 0);

  const intro = { id: 'intro', from: 'bot', text: t('ai.intro', { name: settings.name ? `, ${settings.name}` : '' }) };
  const messages = [intro, ...chat];

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [chat.length, typing]);

  const send = async (value = text) => {
    const v = value.trim();
    if (!v || typing) return;
    setText('');
    await addChat([{ from: 'user', text: v }]);
    setTyping(true);
    const projection = monthProjection({ accounts, txs, cards }, ledger.today);
    const reply = wallyReply(v, { a, goals, money, lang, name: settings.name, t, assets, txs, ledger, projection });
    setTimeout(async () => { await addChat([{ from: 'bot', text: reply }]); setTyping(false); }, 550 + Math.min(reply.length, 600));
  };

  return (
    <div className="page ai-screen">
      <div className="ai-intro">
        <Wally mood={mood} size={52} />
        <div>
          <h1>{t('ai.title')}</h1>
          <p>{t('ai.sub')}</p>
        </div>
        {chat.length > 0 && <button className="icon-btn" onClick={clearChat} title={t('ai.clear')} aria-label={t('ai.clear')}><Eraser size={18} /></button>}
      </div>
      <section className="chat">
        {messages.map((m) => <div key={m.id} className={`msg ${m.from}`}>{m.text}</div>)}
        {typing && <div className="msg bot typing"><i /><i /><i /></div>}
        {!typing && (
          <div className="prompt-grid">
            {advisorPrompts(lang).map((p) => <button key={p} onClick={() => send(p)}>{p}</button>)}
          </div>
        )}
        <div ref={endRef} />
      </section>
      <p className="privacy"><ShieldCheck size={13} /> {t('ai.privacy')}</p>
      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t('ai.placeholder')} enterKeyHint="send" />
        <button type="submit" aria-label={t('ai.send')}><Send size={18} /></button>
      </form>
    </div>
  );
}
