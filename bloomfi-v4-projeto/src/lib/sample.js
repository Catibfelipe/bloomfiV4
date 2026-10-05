import { addDays, addMonths, currentMonth, todayISO, sameDayIn } from './dates.js';
import { uid, round2 } from './format.js';
import { DEFAULT_ACCOUNT_ID, buildInstallments, invoice, invoiceMonthOf, invoiceDates, accountBalance } from './ledger.js';

/**
 * Example data so a new user can explore every feature: two accounts, a credit card with
 * installments and paid invoices, recurring bills (one that needs manual confirmation),
 * scheduled payments, investments, budgets and goals. Removable in Settings.
 */
export function sampleData(lang) {
  const pt = lang === 'pt';
  const k = pt ? 1 : 0.62; // rough scale so numbers feel natural in each currency
  const today = todayISO();
  const cur = currentMonth();
  const day = (iso) => Number(iso.slice(8, 10));
  const txs = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const money = (v) => round2(v * k);
  const base = (o) => ({
    id: uid(), recurring: false, recurringOf: null, skipMonths: [], status: 'paid', autoPay: true, source: 'sample',
    createdAt: Date.now(), loggedOn: o.date, accountId: o.cardId ? null : DEFAULT_ACCOUNT_ID, cardId: null, ...o,
  });

  // ---- accounts & card ----
  const savingsId = uid();
  const cardId = uid();
  const accounts = [
    { id: DEFAULT_ACCOUNT_ID, name: pt ? 'Conta corrente' : 'Checking', type: 'checking', institution: pt ? 'Banco Digital' : 'Digital Bank', color: '#10b981', initialBalance: 0, isDefault: true, sample: true, createdAt: Date.now() },
    { id: savingsId, name: pt ? 'Reserva' : 'Savings', type: 'savings', institution: pt ? 'Banco Digital' : 'Digital Bank', color: '#0ea5e9', initialBalance: money(4200), sample: true, createdAt: Date.now() + 1 },
  ];
  // The last invoice closed 4 days ago and is due in 3 days, so the agenda has something to show.
  const card = {
    id: cardId, name: pt ? 'Cartão Platinum' : 'Platinum card', brand: 'mastercard', limit: money(6000),
    closingDay: day(addDays(today, -4)), dueDay: day(addDays(today, 3)), color: '#8b5cf6', payFrom: DEFAULT_ACCOUNT_ID, sample: true, createdAt: Date.now(),
  };

  // ---- recurring bills and income (template two months ago + the occurrences already due) ----
  const recurring = (o, dayOfMonth) => {
    const start = addMonths(cur, -2);
    const tpl = base({ ...o, date: sameDayIn(`${start}-${String(dayOfMonth).padStart(2, '0')}`, start), recurring: true });
    txs.push(tpl);
    for (let i = 1; i <= 2; i++) {
      const mk = addMonths(start, i);
      const date = sameDayIn(tpl.date, mk);
      if (date > today) continue;
      txs.push(base({ ...o, date, recurringOf: tpl.id, forMonth: mk, autoPay: undefined, status: 'paid' }));
    }
  };
  recurring({ type: 'income', amount: money(4500), category: 'salary', description: pt ? 'Salário' : 'Payroll deposit' }, 1);
  recurring({ type: 'expense', amount: money(1400), category: 'housing', description: pt ? 'Aluguel' : 'Rent' }, 6);
  recurring({ type: 'expense', amount: money(189.9), category: 'bills', description: pt ? 'Conta de luz' : 'Electric bill', autoPay: false }, 10);
  recurring({ type: 'expense', amount: money(119.9), category: 'bills', description: 'Internet' }, 12);
  recurring({ type: 'expense', amount: money(99), category: 'fitness', description: pt ? 'Academia' : 'Gym' }, 8);
  recurring({ type: 'expense', amount: money(55.9), category: 'entertainment', description: 'Netflix', cardId, accountId: null }, 15);
  recurring({ type: 'transfer', amount: money(300), category: 'transfer', description: pt ? 'Guardar na reserva' : 'Move to savings', toAccountId: savingsId }, 2);

  // ---- day-to-day spending, mostly on the card ----
  const variable = pt
    ? [['food', 'iFood', 35, 70], ['groceries', 'Supermercado', 120, 320], ['transport', 'Uber', 14, 38],
       ['coffee', 'Café', 8, 18], ['transport', 'Posto de gasolina', 120, 220], ['shopping', 'Mercado Livre', 60, 240],
       ['health', 'Farmácia', 25, 90], ['food', 'Almoço com colegas', 30, 60], ['entertainment', 'Cinema', 40, 70],
       ['personal', 'Corte de cabelo', 45, 60]]
    : [['food', 'DoorDash', 35, 70], ['groceries', 'Groceries', 120, 320], ['transport', 'Uber', 14, 38],
       ['coffee', 'Starbucks', 8, 18], ['transport', 'Gas station', 120, 220], ['shopping', 'Amazon', 60, 240],
       ['health', 'Pharmacy', 25, 90], ['food', 'Lunch with coworkers', 30, 60], ['entertainment', 'Movie tickets', 40, 70],
       ['personal', 'Haircut', 45, 60]];
  const spend = (date, [category, description, lo, hi], scale = 1) => {
    if (date > today) return;
    const onCard = rnd() < 0.65;
    txs.push(base({ type: 'expense', amount: money(lo + rnd() * (hi - lo) * scale), category, description, date, ...(onCard ? { cardId, accountId: null } : {}) }));
  };
  for (let m = 2; m >= 0; m--) {
    const mk = addMonths(cur, -m);
    for (let d = 1; d <= 28; d += 1) if (rnd() < 0.5) spend(`${mk}-${String(d).padStart(2, '0')}`, variable[Math.floor(rnd() * variable.length)]);
  }
  for (let i = 0; i < 7; i++) spend(addDays(today, -i), variable[i % variable.length], 0.5); // recent activity

  // ---- a purchase in 10 installments ----
  const nbDate = sameDayIn(`${addMonths(cur, -2)}-18`, addMonths(cur, -2));
  for (const p of buildInstallments({ type: 'expense', amount: money(3600), category: 'shopping', description: pt ? 'Notebook' : 'Laptop', date: nbDate, cardId }, 10, card)) {
    txs.push(base({ ...p, cardId, accountId: null }));
  }

  // ---- invoices already due were paid from the checking account ----
  const openMk = invoiceMonthOf(card, today);
  for (let i = 4; i >= 1; i--) {
    const mk = addMonths(openMk, -i);
    const inv = invoice(card, txs, mk, today);
    const { due } = invoiceDates(card, mk);
    if (inv.total > 0 && due <= today) {
      txs.push(base({ type: 'transfer', amount: inv.total, category: 'transfer', description: pt ? `Pagamento da fatura · ${card.name}` : `Card payment · ${card.name}`, date: due, toCardId: cardId, invoice: mk }));
    }
  }

  // ---- scheduled: a bill to pay and money to receive ----
  txs.push(base({ type: 'expense', amount: money(487.3), category: 'transport', description: pt ? 'Seguro do carro' : 'Car insurance', date: addDays(today, 6), status: 'pending' }));
  txs.push(base({ type: 'income', amount: money(1200), category: 'freelance', description: pt ? 'Freela · site institucional' : 'Freelance website', date: addDays(today, 9), status: 'pending' }));

  // ---- investments: monthly contribution leaves the account (debit) ----
  const assets = [
    { id: uid(), name: 'Tesouro Selic 2029', kind: 'tesouro', institution: pt ? 'Tesouro Direto' : 'Treasury', initialInvested: money(6000), valuations: [], source: 'manual', sample: true, createdAt: Date.now() },
    { id: uid(), name: pt ? 'CDB 110% CDI' : 'CD 5.1%', kind: 'renda_fixa', institution: pt ? 'Banco Inter' : 'Ally', initialInvested: money(3000), valuations: [], source: 'manual', sample: true, createdAt: Date.now() },
  ];
  for (let m = 2; m >= 0; m--) {
    const mk = addMonths(cur, -m);
    const date = sameDayIn(`${mk}-07`, mk);
    if (date <= today) txs.push(base({ type: 'invest', amount: money(300), category: 'invest', description: pt ? 'Aporte mensal' : 'Monthly contribution', date, assetId: assets[0].id }));
  }
  assets[0].valuations = [{ date: addDays(today, -20), at: Date.now() - 20 * 86400000, value: Math.round(6000 * k * 1.071 + 300 * k * 2) }];

  // The checking account shows a realistic balance today.
  const target = money(2380);
  accounts[0].initialBalance = round2(target - accountBalance({ ...accounts[0], initialBalance: 0 }, txs, today));

  const budgets = [
    ['food', 600], ['groceries', 900], ['transport', 500], ['shopping', 300], ['entertainment', 200],
  ].map(([category, limit]) => ({ id: uid(), category, limit: Math.round(limit * k), sample: true }));

  const goals = [
    { title: pt ? 'Reserva de emergência' : 'Emergency fund', emoji: '🛟', target: 15000, current: 8500, months: 6 },
    { title: pt ? 'Viagem de férias' : 'Vacation', emoji: '🏝️', target: 5000, current: 2200, months: 11 },
    { title: pt ? 'Quitar cartão de crédito' : 'Pay off credit card', emoji: '💳', target: 3000, current: 1050, months: 3 },
  ].map((g) => ({
    id: uid(), title: g.title, emoji: g.emoji, target: Math.round(g.target * k), current: Math.round(g.current * k),
    deadline: sameDayIn(today, addMonths(cur, g.months)), history: [], createdAt: Date.now(), sample: true,
  }));

  return { transactions: txs, budgets, goals, assets, accounts, cards: [card] };
}
