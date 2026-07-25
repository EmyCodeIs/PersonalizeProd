# Etapa 3 — Handoff humano seguro

## Regra oficial

O handoff só pode ser ativado por evidência positiva de uma destas origens:

1. etiqueta externa realmente vinculada ao contato;
2. mensagem visível enviada pelo WhatsApp Business que não corresponde a nenhum envio registrado pelo bot;
3. mensagem humana encontrada no histórico depois de um checkpoint confirmado do bot ou depois do último `/resetarsys`.

Qualquer outra origem é ignorada e registrada como decisão de segurança.

## Etiquetas

### Não ativam handoff

As etiquetas comerciais gerenciadas pelo próprio sistema:

- `Orçamento letreiros`;
- `Plotagens`;
- `Outros`;
- `Suporte`;
- nomes configurados em `SERVICE_LABEL_REPLACE_GROUP`;
- `AWAITING_QUOTE_LABEL_NAME`, quando configurada.

A comparação é feita pelo nome normalizado. A cor nunca é usada como prova de responsável humano.

Também não ativam handoff:

- evento sem nome de etiqueta;
- evento contendo somente cor ou ID;
- evento incompleto;
- evento marcado como operação interna do bot;
- duplicidade de evento;
- falha de leitura da API.

### Ativam handoff

- nome exato de vendedor configurado (`Adriano`, `Ana`, `Emy`, `C. Eduardo`);
- qualquer outra etiqueta externa com nome visível.

Etiqueta de vendedor gera `seller_label`. Outra etiqueta externa gera `manual_label`.

A remoção só libera um bloqueio por etiqueta depois de uma leitura conclusiva dos aliases necessários do contato. Falha ou indisponibilidade da API nunca é interpretada como remoção.

## Mensagens enviadas pelo vendedor

Antes de cada envio do bot, o `OutboundTracker` registra:

- contato;
- tipo;
- texto ou legenda;
- arquivo;
- horário;
- ID retornado pelo transporte, quando disponível.

Os eventos `fromMe` são comparados com esses registros. O pareamento considera também os aliases `@lid` e `@c.us` do mesmo contato.

Listas interativas, que antes não eram registradas no tracker, passam a ser registradas antes do transporte.

Resultado:

- saída encontrada no tracker: envio do bot, não ativa handoff;
- saída visível sem correspondência: mensagem humana, ativa `manual_outbound_message`.

Eventos internos, tipos invisíveis e duplicidades não ativam handoff.

## Interrupção do atendimento automático

Ao ativar handoff para um cliente normal, o sistema:

1. grava o bloqueio persistente;
2. descarta todos os buffers dos aliases do contato;
3. cancela tarefas ainda aguardando na fila daquele contato;
4. mantém outros clientes e tarefas intactos;
5. consulta novamente o handoff antes de cada texto, imagem, documento, catálogo ou lista;
6. interrompe a resposta em andamento com `HUMAN_HANDOFF_BLOCKED` antes do próximo transporte.

Assim, uma mensagem humana entre dois balões impede o segundo balão.

## Persistência e reinício

Os motivos persistentes válidos são:

- `seller_label`;
- `manual_label`;
- `manual_outbound_message`;
- `manual_outbound_history`.

Motivos antigos ou desconhecidos não podem manter o bot travado e são removidos quando encontrados.

No histórico, ausência de checkpoint do bot é classificada como inconclusiva, não como intervenção humana. Uma saída antiga só ativa handoff quando ocorreu depois de:

- um envio confirmado do bot; ou
- o marco persistente do último `/resetarsys`.

O corte sintético é aplicado somente durante a inspeção de handoff. A recuperação comum continua usando o checkpoint real e não perde respostas recebidas enquanto o sistema estava desligado.

## Tester e `/resetarsys`

A identidade de tester usa exclusivamente:

1. `TEST_COMMAND_ALLOWED_CLIENT_NUMBERS` e `TEST_COMMAND_ALLOWED_CHAT_IDS`, quando preenchidas;
2. `ADMIN_WHATSAPP_NUMBERS` e `ADMIN_WHATSAPP_CHAT_IDS`.

A whitelist geral `ALLOWED_*` nunca transforma um cliente em tester.

Para a tester autorizada:

- mensagem manual não ativa handoff;
- etiqueta externa não ativa handoff;
- bloqueio antigo é removido;
- `/resetarsys` funciona mesmo com `ENABLE_TEST_COMMANDS=false`;
- sessão, perfil, atividade, buffers, fila e handoff são limpos apenas para essa conversa;
- um marco é salvo em `data/handoff-reset-checkpoints.json`;
- mensagens humanas antigas anteriores ao marco não podem voltar a bloquear o teste.

## Logs esperados

Etiqueta nativa:

```text
ETIQUETA · evento=serviço_nativo_ignorado_para_handoff · status=livre
```

Etiqueta externa:

```text
HANDOFF · evento=ativado · motivo=manual_label · etiqueta=Fornecedor
BUFFER · evento=descartado_por_handoff
FILA · evento=cancelada_por_handoff
```

Mensagem humana:

```text
HANDOFF · evento=mensagem_humana_detectada · motivo=manual_outbound_message
HANDOFF · evento=ativado · origem=manual_outbound_message
```

Envio do bot reconhecido:

```text
HANDOFF · evento=saída_do_bot_reconhecida · status=livre
```

Bloqueio no meio de uma resposta:

```text
ENVIO · evento=bloqueado_antes_do_transporte · motivo=manual_outbound_message
```

Reset:

```text
ADMIN · evento=resetarsys_marco_de_histórico · resultado=ok
ADMIN · evento=resetarsys_limpeza_local · resultado=ok
HANDOFF · evento=tester_liberada · status=livre
```

## Testes automáticos

`test-handoff-policy.js` cobre:

- etiquetas nativas;
- etiquetas de vendedor;
- etiquetas externas;
- eventos incompletos;
- identidade estrita da tester;
- aliases `@lid`/`@c.us`;
- listas registradas como saída do bot;
- cancelamento de buffer e fila;
- bloqueio antes do transporte;
- marco de reset.

`test-handoff-history-policy.js` cobre:

- checkpoint real preservado fora da inspeção de handoff;
- ausência de checkpoint como limite inconclusivo dentro do handoff;
- corte persistente criado pelo reset;
- whitelist geral não criando tester;
- tester não recebendo bloqueio histórico.

## Testes reais necessários

1. serviço nativo aplicado pelo bot não bloqueia;
2. etiqueta externa manual bloqueia;
3. etiqueta exata de vendedor bloqueia;
4. remoção da etiqueta externa libera apenas após confirmação;
5. texto manual do vendedor bloqueia;
6. imagem manual do vendedor bloqueia;
7. texto, imagem, catálogo e lista do bot não bloqueiam;
8. mensagem manual entre dois balões impede o segundo;
9. reinício mantém o handoff real;
10. `/resetarsys` libera somente a tester e não reutiliza histórico antigo.
