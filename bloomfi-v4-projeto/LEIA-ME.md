# BloomFi 4.0: sua coruja do dinheiro

App de finanças pessoais para celular e computador (a tela se adapta), instalável como app, com:

- **site de apresentação** em `/` e o app em `/app/`
- **contas e cartões**: várias contas com saldo, transferências, cartões com limite, fatura, parcelas e pagamento de fatura sem contar o gasto duas vezes
- **agenda** de contas a pagar e a receber, com previsão do saldo no fim do mês
- busca rápida (Ctrl+K), desfazer e relatório em PDF
- **sincronização entre aparelhos** com criptografia de ponta a ponta (assinantes)
- **lembretes de contas** por notificação, categorias próprias, letra maior e contato de suporte
- gastos, entradas, orçamentos, metas, relatórios e o assistente **Wally**
- **investimentos**: aplicações saem da conta como **débito**, resgates voltam como crédito
- **Open Finance** (via Pluggy) para bancos, cartões e investimentos automáticos
- **assinatura mensal** (Stripe) com 7 dias grátis e trava de renovação
- **segurança**: dados criptografados (AES-256) no aparelho, PIN de 6 dígitos, biometria, bloqueio automático e backup com senha

👉 **Para publicar e lançar, siga o [LANCAMENTO.md](LANCAMENTO.md).**

## Estrutura

| Pasta/arquivo | O que é |
|---|---|
| `index.html`, `src/landing.css`, `public/landing/` | Site de apresentação (página inicial) |
| `app/index.html`, `src/` | O app (React), publicado em `/app/` |
| `src/lib/ledger.js` | Contas, cartões, faturas, parcelas e agenda |
| `src/lib/sync.js`, `server/storage.js` | Sincronização criptografada entre aparelhos |
| `src/lib/push.js`, `server/webpush.js`, `public/push-sw.js`, `netlify/functions/push-cron.mjs` | Lembretes de contas (notificações) |
| `src/db.js`, `src/lib/vault.js` | Banco de dados local + criptografia |
| `src/lib/billing.js` | Assinatura e licença no aparelho |
| `src/lib/openfinance.js` | Open Finance (Pluggy) |
| `src/lib/investments.js` | Cálculos da carteira |
| `server/` | Servidor (Stripe, licenças, login por e-mail, Pluggy) |
| `netlify/functions/` | Liga o servidor ao Netlify |
| `public/termos.html`, `public/privacidade.html` | Termos e política (rascunhos para preencher) |
| `ferramentas/` | Gerar chaves e códigos de acesso (abrir no navegador, offline) |
| `test/` | Testes do servidor e serviços simulados |
| `.env.example` | Lista de variáveis de ambiente |

## Comandos

```bash
npm install
npm run dev            # desenvolvimento
npm run build          # gera dist/
npm test               # testes do servidor e das regras de contas/cartões
npm run local:teste    # app + servidor com pagamentos e bancos simulados (depois do build)
npm run build:link     # versão de página única (link do claude.ai), sem servidor
python3 scripts/inline-artifact.py saida.html   # junta essa versão num arquivo só
```
