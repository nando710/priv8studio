# PRIV8 Studio

Primeira versão da plataforma web para o workflow RunningHub **28C Body swap**, ID `2108613051860013058`. Interface em português, login individual com ChatGPT, acervo privado por conta, histórico e limites mensais de créditos internos. A chave do proprietário atende todos os membros pelo servidor.

## Ativação inicial

1. Abra o endereço privado do site e entre com sua conta ChatGPT. O primeiro acesso autenticado, enquanto o site é exclusivo do proprietário, inicializa o administrador.
2. Em **Configurações**, informe sua chave do RunningHub. Ela é criptografada no servidor e não é devolvida pela API do painel. Não envie chaves pelo chat.
3. Exporte o workflow 28C no RunningHub como **Workflow API** e importe o JSON no painel. O arquivo deve conter nós com `class_type` e `inputs`. O JSON visual fornecido serviu para mapear o fluxo, mas não substitui esse formato de execução. Esta exportação é uma configuração inicial.
4. Opcionalmente, informe a chave OpenAI e um modelo disponível na sua conta que aceite texto e imagens. Os moldes de prompt vêm da extensão. Sem essa chave, é possível escrever prompts manualmente.
5. Salve e execute uma geração controlada para validar o template, os nós e a API na sua conta. Essa etapa consome créditos dos provedores e **ainda não foi executada** durante a implementação.
6. Após inicializar o administrador, desative `ALLOW_PRIVATE_BOOTSTRAP` nas variáveis do site antes de ampliar o acesso. Cadastre os e-mails dos membros e seus limites em **Contas e limites**. O compartilhamento do site também precisa permitir esses usuários; cadastrar um e-mail no aplicativo, sozinho, não altera o acesso privado do Sites.

O site foi preparado para acesso exclusivo do proprietário. As contas/senhas do servidor antigo não foram migradas: esta versão usa o e-mail autenticado pelo ChatGPT.

## Escopo desta versão

- Envio de cena, modelo e referências adicionais; seleção pelo acervo.
- Prompt manual ou gerado a partir de imagens, com os moldes da extensão.
- Opções de cabeça, máscara, cores, tatuagens, vista, LoRA, seed, etapas e upscale do 28C.
- Execução via API, consulta de resultados e histórico separado por usuário.
- Créditos mensais, concorrência por conta e concorrência total, conferidos no servidor por reserva atômica.
- Proteção contra envio duplicado e retenção de créditos em respostas incertas, com conciliação administrativa.
- Catálogo original como navegação: **somente o 28C está implementado para execução**. As outras ferramentas indicam “Integração em preparação”.

Os créditos são uma regra interna configurável, não o saldo nem o preço real do RunningHub. A consulta de andamento acontece enquanto o painel está aberto e ao retornar. Resultados são links do provedor, cuja retenção não é garantida por este aplicativo. Acervo limitado a 500 MB por usuário, com imagens de até 15 MB (8 MB por referência no gerador de prompts).

Em envios sem resposta conclusiva, confira a cobrança e a tarefa no provedor antes de estornar. Não há repetição automática de tarefas incertas. Uma interrupção durante o envio pode precisar de conciliação. O aplicativo não inclui cobrança financeira, planos pagos, recuperação de senhas próprias ou uma fila de processamento independente.

## Desenvolvimento e validação

Node.js 22.13+; frontend React/Vinext; backend Cloudflare Worker; D1 para dados; R2 para imagens. As migrations em `drizzle/` acompanham a publicação.

```sh
npm install
node scripts/test.mjs
npx tsc --noEmit
npm run dev
```

Use as rotinas do plugin Sites para compilar e publicar. `.dev.vars` é exclusivamente local e ignorado pelo Git. A chave local de teste não pode ser usada em produção. `CREDENTIAL_ENCRYPTION_KEY` precisa de 32 bytes aleatórios em base64 e deve permanecer estável; perdê-la exige cadastrar novamente as credenciais das integrações. A variável de produção já foi configurada como segredo no Sites.

Os testes cobrem limites, concorrência, isolamento das consultas, duplicatas, IDs grandes e montagem das variações do grafo. Os fixtures verificam a estrutura; **não são um workflow API exportado nem comprovam uma execução real no RunningHub**.

## Referências

- [Workflow fornecido](https://www.runninghub.ai/pt-br/workflow/2108613051860013058?source=workspace)
- [RunningHub: criar tarefa](https://www.runninghub.ai/runninghub-api-doc-en/api-425761093)
- [RunningHub: resultados](https://www.runninghub.ai/runninghub-api-doc-en/api-425761099)
- [OpenAI: imagens e visão](https://developers.openai.com/api/docs/guides/images-vision)
