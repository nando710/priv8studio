# Publicar na sua conta da Cloudflare

O PRIV8 Studio roda como um Worker na sua conta da Cloudflare, com o banco **D1**, o acervo no **R2** e o login pelo **Cloudflare Access**. Depois da configuração inicial, cada mudança que entra no branch `main` do GitHub é publicada automaticamente pela ação **Publicar na Cloudflare**.

A configuração é feita uma vez e leva uns 20 minutos. Os planos gratuitos da Cloudflare atendem um estúdio pequeno: o Access é gratuito até 50 usuários, e o R2 pode pedir um cartão cadastrado mesmo no uso gratuito.

## 1. Conta e subdomínio

1. Crie ou acesse sua conta em [dash.cloudflare.com](https://dash.cloudflare.com).
2. Abra **Workers e Pages**. Na lateral direita aparecem o **Account ID** e o seu subdomínio `*.workers.dev` (por exemplo, `fernando.workers.dev`). Anote os dois.

O endereço do site será `https://priv8studio.SEU-SUBDOMINIO.workers.dev`.

## 2. Banco de dados (D1)

1. **Armazenamento e bancos de dados → D1 → Criar banco de dados**.
2. Nome: `priv8studio`.
3. Copie o **Database ID** (o código no formato `xxxxxxxx-xxxx-...`).

As tabelas são criadas automaticamente na primeira publicação.

## 3. Acervo de imagens (R2)

1. **R2 → Criar bucket**.
2. Nome: `priv8studio-acervo`.

## 4. Login (Cloudflare Access)

1. Abra **Zero Trust**. Na primeira vez, escolha um nome de equipe e o plano **Free**. O seu domínio de equipe fica `NOME-DA-EQUIPE.cloudflareaccess.com`; anote.
2. **Access → Aplicações → Adicionar aplicação → Self-hosted**.
3. Nome: `PRIV8 Studio`. Domínio: `priv8studio.SEU-SUBDOMINIO.workers.dev`.
4. Em **Políticas**, crie uma política **Allow** com a regra **Include → Emails** e coloque o seu e-mail e os e-mails dos membros.
5. Métodos de login: o **código por e-mail (One-time PIN)** já vem ativo. Para entrar com Google, adicione o Google em **Settings → Authentication**.
6. Salve a aplicação. Na aba **Overview** dela, copie o **Application Audience (AUD) Tag**.

O app confere a assinatura do Access em cada requisição. Quem chega sem um login válido do Access é recusado.

## 5. Token de API

1. **Meu perfil → Tokens de API → Criar token**.
2. Use o modelo **Edit Cloudflare Workers**.
3. Em **Permissões**, adicione mais uma linha: **Conta → D1 → Editar**.
4. Em **Recursos da conta**, escolha a sua conta. Crie o token e copie.

## 6. Configurar o GitHub

No repositório, abra **Settings → Secrets and variables → Actions**.

Na aba **Secrets**, crie:

| Nome | Valor |
|---|---|
| `CLOUDFLARE_API_TOKEN` | o token do passo 5 |
| `CLOUDFLARE_ACCOUNT_ID` | o Account ID do passo 1 |

Na aba **Variables**, crie:

| Nome | Valor |
|---|---|
| `CF_D1_DATABASE_ID` | o Database ID do passo 2 |
| `ACCESS_TEAM_DOMAIN` | `NOME-DA-EQUIPE.cloudflareaccess.com` |
| `ACCESS_AUD` | o AUD Tag do passo 4 |
| `ADMIN_EMAIL` | os e-mails dos administradores, separados por vírgula |

Se você usou outros nomes, crie também `CF_D1_DATABASE_NAME`, `CF_R2_BUCKET` ou `CF_WORKER_NAME`. Os padrões são `priv8studio`, `priv8studio-acervo` e `priv8studio`.

A chave `CREDENTIAL_ENCRYPTION_KEY`, que protege as chaves do RunningHub e da OpenAI, é criada sozinha na primeira publicação e fica guardada no Worker. Não crie esse segredo no GitHub. Se você criar, ele substitui a chave guardada e as chaves de integração precisam ser cadastradas de novo.

## 7. Publicar

Coloque o código no branch `main`. A ação **Publicar na Cloudflare** roda os testes, cria as tabelas e publica. Para publicar sem mudar código, use **Actions → Publicar na Cloudflare → Run workflow**.

## 8. Primeiro acesso

1. Abra `https://priv8studio.SEU-SUBDOMINIO.workers.dev` e entre com um dos e-mails de `ADMIN_EMAIL`. Esses e-mails são sempre administradores.
2. Em **Configurações**, cadastre a chave do RunningHub, o workflow 28C em formato API e a chave da OpenAI.
3. Para cada membro, libere o e-mail na política do Access (passo 4) **e** cadastre em **Contas e limites**.

O app começa vazio na Cloudflare: contas, histórico e acervo do Sites não são transferidos.

## Publicar pelo seu computador (opcional)

Com Node.js 22 e as mesmas variáveis definidas no terminal:

```sh
npm ci
node scripts/deploy-cloudflare.mjs            # publica
node scripts/deploy-cloudflare.mjs --dry-run  # só confere o build, sem publicar
```
