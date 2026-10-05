/**
 * Open Finance through Pluggy (regulated by Banco Central).
 * The Pluggy Connect window collects the bank login; BloomFi never sees
 * passwords. Our server holds the Pluggy keys and only answers for the
 * subscriber who owns each connection.
 */
import { api } from './billing.js';
import { classifyMovement, guessCategory, BILL_PAYMENT } from './categories.js';
import { kindFromPluggy } from './investments.js';
import { todayISO, addDays } from './dates.js';
import { invoiceForPayment } from './ledger.js';

const PLUGGY_SRC = 'https://cdn.pluggy.ai/pluggy-connect/v2.8.2/pluggy-connect.js';
let scriptPromise = null;

function loadPluggyScript() {
  if (window.PluggyConnect) return Promise.resolve();
  if (!scriptPromise) {
    scriptPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PLUGGY_SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { scriptPromise = null; reject(Object.assign(new Error('widget_load_failed'), { code: 'widget_load_failed' })); };
      document.head.appendChild(s);
    });
  }
  return scriptPromise;
}

/** Opens the bank connection window. Resolves with the Pluggy item, or null if closed. */
export async function openConnect({ license, sandbox, lang, itemId }) {
  const { accessToken } = await api('of/connect-token', { method: 'POST', body: itemId ? { itemId } : {}, token: license });
  await loadPluggyScript();
  return new Promise((resolve, reject) => {
    let done = false;
    const widget = new window.PluggyConnect({
      connectToken: accessToken,
      includeSandbox: !!sandbox,
      language: lang === 'pt' ? 'pt' : 'en',
      theme: 'dark',
      ...(itemId ? { updateItem: itemId } : {}),
      onSuccess: (data) => { done = true; resolve(data?.item || null); },
      onError: (err) => { if (!done) { done = true; reject(Object.assign(new Error('connect_failed'), { code: 'connect_failed', detail: err })); } },
      onClose: () => { if (!done) { done = true; resolve(null); } },
    });
    widget.init();
  });
}

export async function fetchItemData({ license, itemId, from }) {
  const item = await api(`of/item?id=${encodeURIComponent(itemId)}`, { token: license });
  const { results: accounts } = await api(`of/accounts?itemId=${encodeURIComponent(itemId)}`, { token: license });
  const txByAcc = {};
  for (const a of accounts) {
    txByAcc[a.id] = (await api(`of/transactions?accountId=${encodeURIComponent(a.id)}&from=${from}`, { token: license, timeout: 60000 })).results;
  }
  let investments = [];
  try { investments = (await api(`of/investments?itemId=${encodeURIComponent(itemId)}`, { token: license })).results; } catch { /* product may be unavailable */ }
  return { item, accounts, txByAcc, investments };
}

export async function deleteItem({ license, itemId }) {
  return api(`of/item?id=${encodeURIComponent(itemId)}`, { method: 'DELETE', token: license });
}

const PLUGGY_CATS = [
  [/groceries|supermarket/i, 'groceries'], [/food|restaurant|eating|delivery|drink/i, 'food'],
  [/transport|taxi|ride|gas station|fuel|parking|toll/i, 'transport'], [/pharmac|health|medical|dentist|hospital/i, 'health'],
  [/utilit|electric|water|internet|telecom|phone bill/i, 'bills'], [/rent|housing|mortgage/i, 'housing'],
  [/education|school|course|book/i, 'education'], [/travel|accommodation|airline|airport|hotel/i, 'travel'],
  [/streaming|entertainment|leisure|digital service|games|cinema/i, 'entertainment'],
  [/shopping|clothing|electronics|department|online/i, 'shopping'], [/pet/i, 'pets'], [/gift|donation/i, 'gifts'],
  [/gym|fitness|sport/i, 'fitness'], [/loan|interest|tax|fee|bank fee/i, 'debt'],
];
function expenseCategory(desc, pluggyCat) {
  const g = guessCategory(desc, 'expense');
  if (g !== 'other' || !pluggyCat) return g;
  for (const [re, key] of PLUGGY_CATS) if (re.test(pluggyCat)) return key;
  return 'other';
}

const BRANDS = { MASTERCARD: 'mastercard', VISA: 'visa', ELO: 'elo', AMEX: 'amex', 'AMERICAN EXPRESS': 'amex', HIPERCARD: 'hipercard' };
const dayOf = (iso, fallback) => {
  if (!iso) return fallback;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? fallback : d.getUTCDate();
};

/**
 * Turns bank data into BloomFi accounts, cards, transactions and assets
 * (transactions are deduplicated by importId upstream).
 */
export function mapItemData({ item, accounts, txByAcc, investments }, connectionId) {
  const bankName = item?.connector?.name || '';
  const color = item?.connector?.primaryColor ? `#${String(item.connector.primaryColor).replace('#', '')}` : '#8b5cf6';
  const outAccounts = accounts.filter((a) => a.type === 'BANK').map((a) => ({
    id: `of:${a.id}`, externalId: a.id, name: a.name || bankName, institution: bankName,
    type: a.subtype === 'SAVINGS_ACCOUNT' ? 'savings' : 'checking', color, bankBalance: Number(a.balance) || 0,
    number: a.number || '', source: 'openfinance', connectionId, createdAt: Date.now(),
  }));
  const outCards = accounts.filter((a) => a.type === 'CREDIT').map((a) => {
    const limit = Number(a.credit?.limit) || 0;
    const available = a.credit?.available != null ? Number(a.credit.available) : null;
    return {
      id: `of:${a.id}`, externalId: a.id, name: a.name || bankName, institution: bankName,
      brand: BRANDS[String(a.credit?.brand || '').toUpperCase()] || 'other', limit,
      closingDay: dayOf(a.credit?.closeDate, 1), dueDay: dayOf(a.credit?.dueDate, 10), color,
      bankUsed: limit && available != null ? limit - available : Number(a.balance) || 0, bankAvailable: available,
      number: a.number || '', source: 'openfinance', connectionId, createdAt: Date.now(),
    };
  });
  const onlyCard = outCards.length === 1 ? outCards[0] : null;
  const txs = [];
  for (const acc of accounts) {
    for (const t of txByAcc[acc.id] || []) {
      if (t.status === 'PENDING') continue;
      let desc = (t.description || '').replace(/\s+/g, ' ').trim().slice(0, 80) || '—';
      if (t.installment && !desc.includes(`(${t.installment})`)) desc = `${desc} (${t.installment})`;
      const date = String(t.date).slice(0, 10);
      const base = { date, description: desc, importId: `of:${t.id}`, source: 'openfinance', connectionId, status: 'paid' };
      const amt = Number(t.amount) || 0;
      if (acc.type === 'CREDIT') {
        const cardId = `of:${acc.id}`;
        // Card: positive = new charge. Negative = bill payment (comes from the bank side) or a refund.
        if (amt > 0) txs.push({ ...base, cardId, type: 'expense', amount: amt, category: expenseCategory(desc, t.category) });
        else if (!BILL_PAYMENT.test(desc) && !/payment/i.test(t.category || '')) txs.push({ ...base, cardId, type: 'income', amount: -amt, category: 'other_income' });
        continue;
      }
      const accountId = `of:${acc.id}`;
      const isBill = amt < 0 && (BILL_PAYMENT.test(desc) || /credit card payment/i.test(t.category || ''));
      if (isBill) {
        // Paying a card invoice moves money to the card; the purchases were already counted.
        // With one connected card we know which; otherwise it is a transfer out with no known destination.
        txs.push({
          ...base, accountId, type: 'transfer', amount: -amt, category: 'transfer',
          toCardId: onlyCard ? onlyCard.id : null, invoice: onlyCard ? invoiceForPayment(onlyCard, date) : null,
        });
        continue;
      }
      const c = classifyMovement(desc, amt);
      if (c.type === 'invest' || c.type === 'redeem') txs.push({ ...base, accountId, type: c.type, amount: Math.abs(amt), category: c.category });
      else if (amt < 0) txs.push({ ...base, accountId, type: 'expense', amount: -amt, category: expenseCategory(desc, t.category) });
      else if (amt > 0) txs.push({ ...base, accountId, type: 'income', amount: amt, category: /salary|payroll/i.test(t.category || '') ? 'salary' : c.category });
    }
  }
  const assets = (investments || []).filter((v) => (v.balance ?? v.amount) > 0).map((v) => ({
    id: `of:${v.id}`, externalId: v.id, name: v.name || 'Investimento', kind: kindFromPluggy(v.type, v.subtype),
    institution: bankName, currentValue: Number(v.balance ?? v.amount) || 0,
    investedBase: Number(v.amountOriginal ?? v.amount ?? v.balance) || 0, dueDate: v.dueDate || null,
    source: 'openfinance', connectionId, valueUpdatedAt: v.date || new Date().toISOString(), createdAt: Date.now(),
  }));
  return { txs, assets, accounts: outAccounts, cards: outCards };
}

/** Fake bank used when the server isn't configured yet (clearly labeled as demo). */
export function demoItemData(itemId) {
  const d = (n) => addDays(todayISO(), -n);
  const bank = { id: `${itemId}-bank`, type: 'BANK', subtype: 'CHECKING_ACCOUNT', name: 'Conta corrente (demo)', balance: 2847.35 };
  const close = addDays(todayISO(), 12);
  const card = {
    id: `${itemId}-card`, type: 'CREDIT', name: 'Cartão (demo)', balance: 148.3,
    credit: { limit: 6000, available: 5851.7, brand: 'MASTERCARD', closeDate: `${close}T00:00:00.000Z`, dueDate: `${addDays(close, 7)}T00:00:00.000Z` },
  };
  const mk = (id, description, amount, n, category) => ({ id: `${itemId}-${id}`, description, amount, date: d(n), status: 'POSTED', category });
  return {
    item: { id: itemId, connector: { name: 'Banco Demonstração', primaryColor: '8b5cf6' }, status: 'UPDATED' },
    accounts: [bank, card],
    txByAcc: {
      [bank.id]: [
        mk('t1', 'Salário EMPRESA DEMO', 5200, 3, 'Salary'), mk('t2', 'Aplicação RDB', -700, 3, 'Investments'),
        mk('t3', 'Pagamento de fatura', -640.5, 6, 'Credit card payment'), mk('t4', 'Supermercado Demo', -312.4, 4, 'Groceries'),
        mk('t5', 'Conta de luz', -176.3, 8, 'Utilities'), mk('t6', 'Resgate RDB', 120, 1, 'Investments'),
      ],
      [card.id]: [
        mk('c1', 'IFOOD *DEMO', 64.9, 2, 'Food and drinks'), mk('c2', 'UBER *TRIP', 27.5, 2, 'Transportation'),
        mk('c3', 'NETFLIX.COM', 55.9, 9, 'Entertainment'), mk('c4', 'Pagamento recebido', -640.5, 6, 'Credit card payment'),
      ],
    },
    investments: [
      { id: `${itemId}-i1`, name: 'Tesouro Selic 2029 (demo)', type: 'FIXED_INCOME', subtype: 'TREASURY', balance: 8240.55, amountOriginal: 8000 },
      { id: `${itemId}-i2`, name: 'CDB 110% CDI (demo)', type: 'FIXED_INCOME', subtype: 'CDB', balance: 3150.2, amountOriginal: 3000 },
    ],
  };
}
