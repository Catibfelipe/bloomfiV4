# Guia de lançamento do BloomFi 4.0

Siga na ordem. Tudo começa em **modo de teste** (nenhum dinheiro real), e só no fim você liga o modo real.

---

## O que mudou no app (resumo)

**Novo na versão 4.1**

| Recurso | Como funciona |
|---|---|
| **Sincronizar aparelhos** | Ajustes → Sincronizar aparelhos. A pessoa cria uma senha de sincronização e os dados passam a ser os mesmos no celular e no computador. A cópia no servidor é criptografada no aparelho: nem você consegue ler. Em aparelho novo, depois de entrar com o e-mail, aparece "Seus dados estão na nuvem". Também resolve quem perde o celular. Só para assinantes. |
| **Lembretes de contas** | Ajustes → Lembretes de contas. Aviso no celular um dia antes e no dia do vencimento, mesmo com o app fechado (no iPhone, com o app instalado na tela de início, iOS 16.4 ou mais novo). Por padrão o aviso só diz quantas contas vencem, sem nomes nem valores. |
| **Importar para a conta certa** | Ao importar um extrato, a pessoa escolhe a conta ou o cartão. Fatura de cartão é reconhecida sozinha: as compras entram no cartão e o pagamento da fatura é ignorado. |
| **Categorias próprias** | Criar categorias com nome, ícone e cor (Ajustes → Categorias ou o botão "Nova" no lançamento). |
| **Letra maior** | Ajustes → Tamanho do texto: Normal, Grande ou Muito grande. |
| **Suporte** | WhatsApp e e-mail de suporte no app, na tela de assinatura e no site (variáveis `SUPPORT_WHATSAPP` e `SUPPORT_EMAIL`). |

**Da versão 4**

| Recurso | Como funciona |
|---|---|
| **Site de apresentação** | O endereço principal (`/`) agora é uma página de vendas com fotos reais do app, preço, segurança e perguntas frequentes. O app fica em **`/app/`**. Quem já tinha instalado continua abrindo o app normalmente. |
| **Contas e cartões** | Várias contas (corrente, poupança, dinheiro…) com saldo real, transferências entre elas e ajuste de saldo. Cartões de crédito com limite, dia de fechamento e vencimento, compras parceladas (o limite fica reservado), fatura mês a mês e pagamento de fatura **sem contar o gasto duas vezes**. Patrimônio líquido somado. |
| **Agenda** | Contas a pagar e a receber, faturas do cartão e recorrentes. Marcar como pago com um toque (com "Desfazer"), pular um mês, aviso de atrasadas no menu e saldo previsto para o fim do mês. |
| **Extras** | Gráfico da evolução do saldo, busca rápida (Ctrl+K ou a lupa no celular), "Desfazer" ao excluir ou pagar e relatório do mês em PDF. O visual continua o mesmo de antes. |
| **Open Finance** | Agora cria as contas e os cartões do banco com o saldo e o limite informados pelo banco, e o pagamento da fatura vira transferência para o cartão. |
| **Quem já usava** | Tudo continua: os lançamentos antigos vão para a "Conta principal" e o app mostra um aviso do que é novo. Vale conferir o saldo em **Contas e cartões → Ajustar saldo**. |

**Da versão 3**

| Recurso | Como funciona |
|---|---|
| **Assinatura** | 7 dias grátis, depois R$ 14,90/mês pelo Stripe. Quando vence, o app trava numa tela de renovação, mas a pessoa **sempre** consegue baixar o backup dos dados dela. Funciona offline até a data paga (+3 dias de tolerância). |
| **Aporte = débito** | Novo botão **Investir** nos lançamentos: "Aplicar" sai da conta como débito (não conta como gasto) e "Resgatar" volta como crédito. Metas e extratos ("Aplicação RDB", "Dinheiro guardado", "Tesouro"…) seguem a mesma regra. |
| **Investimentos** | Carteira com valor atual, quanto aportou, rentabilidade, distribuição por tipo e aportes por mês. |
| **Segurança** | Criptografia AES-256 de todos os dados no aparelho com PIN de 6 dígitos, biometria (Face ID/digital), bloqueio automático, limite de tentativas, botão de ocultar valores, backup protegido por senha e cabeçalhos de segurança no site. |
| **Open Finance** | Conexão regulada via Pluggy: contas, cartões e investimentos chegam sozinhos (só para assinantes). Sem as chaves, funciona em **modo demonstração**. |

---

## Passo 0 — Contas que você vai precisar

| Serviço | Para quê | Custo |
|---|---|---|
| **GitHub** (github.com) | Guardar o código; o Netlify publica a partir dele | Grátis |
| **Netlify** (netlify.com) | Hospedar o app e o servidor | Plano grátis atende o começo |
| **Stripe** (stripe.com/br) | Cobrar a assinatura | Taxa por cobrança, confira em stripe.com/br/pricing |
| **Pluggy** (pluggy.ai) | Open Finance | Teste grátis; produção é contratada com eles |
| **Resend** (resend.com) — opcional | E-mail com código para recuperar a assinatura em outro aparelho | Plano grátis |

> ⚠️ O Netlify **Drop** (arrastar a pasta) **não publica o servidor**. Para assinatura e Open Finance funcionarem, publique pelo GitHub (Passo 5).

---

## Passo 1 — Gerar as chaves do servidor (1 minuto)

1. Abra o arquivo `ferramentas/gerar-chaves.html` (dois cliques; abre no navegador e roda só no seu computador).
2. Clique em **Gerar chaves**.
3. Guarde os três valores num lugar seguro (ex.: gerenciador de senhas):
   - `APP_SECRET`
   - `LICENSE_PRIVATE_JWK`
   - `VAPID_PRIVATE_JWK` (lembretes de contas no celular)

Nunca mande essas chaves para ninguém. Elas são o que impede alguém de "fabricar" uma assinatura.

---

## Passo 2 — Stripe (pagamentos)

1. Crie a conta em stripe.com/br. Fique no **modo de teste** (chave no canto superior direito).
2. **Developers → API keys** → copie a **Secret key** (`sk_test_...`). Ela vira a variável `STRIPE_SECRET_KEY`.
3. **Settings → Billing → Customer portal** → ative o portal e marque **"Customers can cancel subscriptions"**. É por ele que o cliente cancela sozinho (exigência do Código de Defesa do Consumidor).
4. (Opcional) Crie um produto "BloomFi Premium" com preço recorrente mensal de R$ 14,90 e copie o ID `price_...` para `STRIPE_PRICE_ID`. Sem isso, o servidor usa `PRICE_CENTS=1490` automaticamente.

---

## Passo 3 — Pluggy (Open Finance)

1. Crie a conta em dashboard.pluggy.ai e crie uma **Application**.
2. Copie o **Client ID** e o **Client Secret**, que viram as variáveis `PLUGGY_CLIENT_ID` e `PLUGGY_CLIENT_SECRET`.
3. Deixe `PLUGGY_SANDBOX=true` para testar com o banco fictício "Pluggy Bank" (as credenciais de teste aparecem na própria janela da Pluggy).
4. Para conectar bancos reais, solicite à Pluggy o acesso de produção ao Open Finance (eles pedem dados da sua empresa e da sua política de privacidade). Depois disso, mude para `PLUGGY_SANDBOX=false`.

---

## Passo 4 — Resend (opcional, recomendado)

Serve para o assinante recuperar a assinatura num celular novo com um código no e-mail.

1. Crie a conta em resend.com → **API Keys** → crie uma chave, que vira `RESEND_API_KEY`.
2. Em **Domains**, verifique o seu domínio para enviar de `nao-responda@seudominio.com.br` (variável `EMAIL_FROM`). Sem domínio verificado, o Resend só envia para o seu próprio e-mail.

Sem o Resend, o resto funciona; a pessoa só não tem o "Já sou assinante" por e-mail (pode usar o backup, que leva a assinatura junto).

---

## Passo 5 — Publicar (GitHub + Netlify)

**No GitHub:**
1. Crie um repositório **privado** chamado `bloomfi`.
2. Clique em **uploading an existing file** e arraste **todo o conteúdo** da pasta do projeto (menos `node_modules` e `dist`, se existirem). Clique em **Commit changes**.

**No Netlify:**
1. **Add new project → Import an existing project → GitHub** → escolha `bloomfi`.
2. As configurações de build já vêm do arquivo `netlify.toml`, então não mexa.
3. Antes de publicar, em **Environment variables**, adicione (copie os nomes do arquivo `.env.example`):

   | Variável | Valor |
   |---|---|
   | `APP_SECRET` | do Passo 1 |
   | `LICENSE_PRIVATE_JWK` | do Passo 1 (o texto inteiro, com chaves `{ }`) |
   | `STRIPE_SECRET_KEY` | `sk_test_...` |
   | `PLUGGY_CLIENT_ID` / `PLUGGY_CLIENT_SECRET` | da Pluggy |
   | `PLUGGY_SANDBOX` | `true` |
   | `RESEND_API_KEY` / `EMAIL_FROM` | opcional |
   | `FREE_ACCESS_EMAILS` | e-mails da família, separados por vírgula (opcional) |
   | `VAPID_PRIVATE_JWK` | do Passo 1 (lembretes de contas) |
   | `SUPPORT_EMAIL` | e-mail de suporte mostrado no app e no site (opcional) |
   | `SUPPORT_WHATSAPP` | WhatsApp de suporte, só números com 55 e DDD, ex.: `5511999998888` (opcional) |

   A sincronização entre aparelhos e os lembretes usam o armazenamento do próprio Netlify (Netlify Blobs) e uma função que roda de hora em hora. Não precisa configurar nada além das variáveis acima.

4. **Deploy**. Em ~1 minuto você recebe o link `https://….netlify.app`. Dá para trocar o nome em *Site configuration → Change site name* ou usar um domínio próprio.

Para atualizar o app depois: envie os arquivos novos ao GitHub do mesmo jeito, e o Netlify publica sozinho. Quem já instalou vê "Nova versão disponível → Atualizar", **sem perder dados**.

---

## Passo 6 — Testar antes de lançar (modo teste)

Abra o link e confira:

- [ ] O endereço principal mostra o site; **Começar 7 dias grátis** abre o app em `/app/`.
- [ ] Onboarding → aparece "Teste grátis: 7 dias restantes".
- [ ] **Ajustes → Assinatura → Assinar agora** → use o cartão de teste `4242 4242 4242 4242`, validade futura qualquer, CVC qualquer.
- [ ] Volta para o app com "Assinatura ativa!".
- [ ] **Gerenciar ou cancelar** abre o portal do Stripe.
- [ ] **Open Finance → Conectar banco** → escolha o banco de teste da Pluggy → as transações e investimentos aparecem.
- [ ] Faça um lançamento **Investir → Aplicar** e confira que o saldo do mês diminui e "Gastos" não muda.
- [ ] **Contas e cartões → Novo cartão**, faça uma compra parcelada e depois **Pagar fatura**: os gastos do mês não mudam com o pagamento.
- [ ] Agende uma conta para daqui a 3 dias e pague pela **Agenda**.
- [ ] **Ajustes → Lembretes de contas** no celular instalado → **Enviar um aviso de teste** chega no celular.
- [ ] **Ajustes → Sincronizar aparelhos** no celular; no computador, entre com o mesmo e-mail e toque em **Trazer meus dados**.
- [ ] Importe a fatura do cartão (CSV) e confira que as compras foram para o cartão.
- [ ] **Ajustes → Segurança → Criar PIN** → feche e abra o app: pede o PIN.
- [ ] Em outro navegador: **Já sou assinante** → código no e-mail → assinatura recuperada.

---

## Passo 7 — Família e amigos de graça

Duas opções:

- **Pelo e-mail:** coloque os e-mails em `FREE_ACCESS_EMAILS` no Netlify. A pessoa entra com "Já sou assinante" (precisa do Resend).
- **Por código:** abra `ferramentas/gerar-codigo-acesso.html`, cole seu `APP_SECRET`, o e-mail e quantos dias (ou, no Terminal, `npm run acesso -- email@exemplo.com 365`, que lê o `APP_SECRET` do `.env`). Mande o código para a pessoa colar em **Tenho um código de acesso**.

---

## Passo 8 — Ligar o modo real

1. **Stripe:** ative a conta (dados pessoais/CNPJ e conta bancária), configure o Customer portal também no modo real e troque `STRIPE_SECRET_KEY` por `sk_live_...` (e `STRIPE_PRICE_ID`, se usou, pelo preço do modo real).
2. **Pluggy:** produção liberada → `PLUGGY_SANDBOX=false`.
3. **Preço no site:** se mudar o preço (`PRICE_CENTS`), troque também o texto "R$ 14,90" em `index.html` (a página de apresentação).
4. **Termos e Privacidade:** preencha os campos marcados em `public/termos.html` e `public/privacidade.html` (nome/CNPJ, e-mail, data). Revisão de um advogado é recomendada.
5. Faça um novo deploy (Netlify → Deploys → Trigger deploy).

---

## Testar no seu computador (opcional, para quem programa)

```bash
npm install
npm test                          # testes do servidor e das contas/cartões/faturas
npm run build && npm run local:teste   # app completo com Stripe/Pluggy/e-mail simulados
```

---

## Limitações que você deve conhecer

- **Os dados ficam no aparelho**, a menos que a pessoa ligue a sincronização (assinantes). Sem ela, para levar os dados use backup e restauração.
- **A senha de sincronização não tem recuperação.** Se a pessoa esquecer, os dados continuam nos aparelhos dela, mas a cópia na nuvem precisa ser apagada e criada de novo.
- **Lembretes no iPhone** só funcionam com o app instalado na tela de início (iOS 16.4 ou mais novo).
- **O PIN não tem recuperação.** É o preço da criptografia de verdade. Oriente os usuários a fazer backup com senha.
- **A trava de renovação roda no aparelho.** A licença é assinada digitalmente e não dá para falsificar, mas uma pessoa com conhecimento técnico poderia modificar o código do app no próprio navegador. O que fica 100% protegido no servidor é o Open Finance (só responde a assinantes válidos). É o mesmo limite de qualquer app web.
- **Biometria** exige navegador/aparelho com suporte a "passkeys com PRF" (iPhone com iOS 18+, Android e Chrome/Edge recentes). Onde não houver, o app usa só o PIN.
