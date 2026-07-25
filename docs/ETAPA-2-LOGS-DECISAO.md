# Etapa 2 — Logs de decisão e correlação

## Objetivo

Completar os logs existentes da `PersonalizeProd` sem substituir o logger atual e sem alterar o comportamento comercial. Cada mensagem passa a deixar uma trilha explicando:

- de onde entrou;
- qual identidade foi resolvida;
- em qual etapa comercial estava;
- se o handoff permitiu ou bloqueou;
- quando entrou e saiu do buffer;
- quando entrou, iniciou e terminou na fila;
- qual transição o fluxo realizou;
- quantos envios foram tentados e confirmados;
- quais etiquetas e notas foram operadas;
- o que a recuperação verificou;
- qual erro interrompeu o caminho.

## Categorias padronizadas

- `SISTEMA`
- `ENTRADA`
- `IDENTIDADE`
- `RECUPERAÇÃO`
- `HANDOFF`
- `BUFFER`
- `FILA`
- `FLUXO`
- `ENVIO`
- `ETIQUETA`
- `NOTA`
- `ADMIN`
- `CONEXÃO`
- `ERRO`

Os logs antigos continuam existindo nesta etapa. Os novos registros são acrescentados ao redor dos pontos de decisão para reduzir o risco de regressão.

## Correlação

`src/core/decisionLogger.js` usa `AsyncLocalStorage` para manter o contexto durante uma execução assíncrona. O identificador curto `msg` é derivado do ID real da mensagem; quando ele não existe, é derivado de chat, texto e timestamp.

Exemplo:

```text
ENTRADA · evento=recebida · chat=5531...@c.us · msg=A82F31 · etapa=cidade · origem=event · tipo=texto · texto="Betim"
IDENTIDADE · evento=resolvida · chat=5531...@c.us · msg=A82F31 · etapa=cidade · original=... · canônico=...
HANDOFF · evento=verificado_antes_do_buffer · chat=... · msg=A82F31 · status=livre
BUFFER · evento=agendado · chat=... · msg=A82F31 · etapa=cidade · espera=2500ms
FILA · evento=iniciada · chat=... · msg=A82F31 · etapa=cidade · espera=18ms
FLUXO · evento=concluído · chat=... · msg=A82F31 · de=cidade · para=envio · envios=1 · respondeu=sim
```

## Pontos instrumentados

### Entrada e identidade

`src/index.js` registra recebimento, origem, tipo, texto resumido, identidade original, identidade canônica e descarte por whitelist ou duplicidade.

### Handoff

São registrados os três bloqueios já existentes:

1. antes do buffer;
2. antes da fila;
3. antes de executar o fluxo.

Mensagem manual enviada pelo humano registra bloqueio e quantidade de mensagens descartadas do buffer. Saídas reconhecidas pelo `outboundTracker` continuam livres.

### Buffer e fila

O buffer registra agendamento, liberação, descarte e falha de flush. `BufferManager.clear()` passa a retornar somente a quantidade removida; chamadores antigos podem ignorar o retorno e o comportamento permanece igual.

A fila registra posição, unidades, espera, início, conclusão, timeout e falha tardia. Nenhum limite ou política de concorrência foi alterado.

### Fluxo

Antes do `processCustomerMessage`, a etapa persistida é registrada. Depois, são registrados etapa anterior, etapa seguinte, duração, quantidade de envios e se houve resposta. Erros continuam sendo propagados.

### Envios

`src/core/decisionChannelInstrumentation.js` envolve, sem substituir a implementação interna:

- texto;
- imagem;
- documento;
- catálogo;
- listas interativas;
- nota do contato;
- etiqueta;
- marcar como não lida.

O wrapper preserva argumentos, `this`, retorno, `false`, `null` e exceções. O erro nunca é engolido.

### Etiquetas

`serviceLabels.js` registra localização, reutilização, tentativa de criação, criação, ausência, aplicação e confirmação. A API e a ordem existentes não foram trocadas nesta etapa.

### Conexão e recuperação

São registrados QR disponível, status do WPPConnect, mudança de estado, criação do canal, manutenção inicial de etiquetas, reconciliação de sessões, respostas pendentes e bootstrap de não lidas.

## Proteção do comportamento

Não foram alterados:

- mensagens ao cliente;
- menus e listas;
- assets;
- sequência comercial;
- regras de handoff;
- regras de recuperação;
- regras de etiquetas;
- `/resetarsys`;
- limites de buffer ou fila;
- delays e digitação.

O baseline foi atualizado apenas para os arquivos intencionalmente instrumentados e passou a proteger também o logger e os wrappers novos.

## Validação

- sintaxe verificada em 95 arquivos;
- baseline aprovado com 20 arquivos de runtime, 8 assets e 22 preloads;
- teste específico de correlação e instrumentação aprovado;
- suíte completa `npm test` aprovada localmente;
- inicialização em `MOCK_MODE` aprovada com o novo resumo de sistema e conexão.

## Teste real necessário

Ainda é necessário iniciar a branch com o WhatsApp conectado e validar pelo menos:

1. mensagem normal em uma etapa já aberta;
2. lista interativa;
3. imagem automática;
4. mensagem humana durante o buffer;
5. etiqueta de vendedor;
6. reinício com sessão pendente;
7. erro ou timeout controlado de envio.

A Etapa 2 torna esses cenários observáveis, mas não corrige ainda as regras das Etapas 3 a 6.
