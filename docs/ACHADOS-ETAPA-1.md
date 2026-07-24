# Achados da Etapa 1 — Dívidas observadas sem correção

Este arquivo não afirma que cada item já causou falha no WhatsApp real. Ele registra sobreposições e incompatibilidades confirmadas no código da `main` `fe6ca12`, para orientar as próximas etapas sem reconstruir o fluxo.

## 1. O `.env` descreve recursos que a `main` não consome

As chaves de BaseBots, prontidão WPP, reconexão, diretórios WPP, logger persistente e limites de outbox listadas em `MATRIZ-ENV-PRODUCAO.md` não são lidas pela versão ativa. Isso cria falsa sensação de configuração: o valor muda no arquivo, mas o comportamento não muda.

## 2. Administração do `/resetarsys` usa nomes diferentes

O `.env` informado usa `ADMIN_WHATSAPP_NUMBERS` e `ADMIN_WHATSAPP_CHAT_IDS`; a `main` procura `TEST_COMMAND_ALLOWED_*`. A autorização real depende de fallback e normalização de identidade, que será tratada na Etapa 6.

## 3. Reset está distribuído em várias camadas

O entrypoint carrega, em sequência:

- `resetCommandHandoffPreload`;
- `testCommandAccessPreload`;
- `resetCleanupPreload`;
- `safeResetCleanupOverridePreload`.

Além disso, `bootstrap.js` envolve `channel.sendText` para executar limpeza quando encontra uma frase específica de confirmação. A Etapa 6 deverá consolidar o comando acima do fluxo sem apagar comportamento comercial.

## 4. Recuperação possui caminhos concorrentes

Foram identificados:

- retomada de sessões ativas em `src/index.js`;
- bootstrap opcional de mensagens não lidas;
- recuperação de reconexão instalada por `unreadReconnectRecoveryPreload`.

Esses caminhos precisam compartilhar journal, identidade, handoff e deduplicação na Etapa 4. Nesta etapa nenhuma regra foi alterada.

## 5. Etiquetas são inicializadas por mais de um ponto

`bootstrap.js` envolve a criação do canal para executar `runLabelStartupOnce`, enquanto `src/index.js` também chama `initializeServiceLabels(channel)`. Existem proteções de idempotência, mas a ordem e a prontidão da API WPP continuam sendo parte crítica da Etapa 5.

## 6. Handoff possui regra-base e regra sobrescrita

A função-base de `sellerHandoff` classifica qualquer etiqueta não gerenciada como `manual_label`. Depois, `vpsReadinessPreload` substitui a detecção para reconhecer vendedor apenas pelo nome exato. Portanto, o comportamento final depende da ordem dos preloads — agora protegida pelo baseline — e precisa ser validado no WhatsApp real na Etapa 3.

## 7. Testes comerciais estavam atrás da produção

Dois testes esperavam um emoji `😊` na mensagem final, mas `src/core/messages.js` da produção não contém esse emoji. Os testes foram alinhados ao texto real; a mensagem enviada ao cliente não foi modificada.

O teste-base de handoff também esperava que etiquetas não exatas retornassem `null`, embora a função-base atual retorne `manual_label`. O teste foi corrigido para descrever a implementação ativa; nenhuma regra de handoff foi alterada.

## 8. A ordem dos preloads é parte do sistema

A produção não é apenas `customerFlow.js`. Vinte e dois preloads alteram módulos e funções antes do bootstrap. Mudar a ordem pode alterar catálogo, handoff, reset, etiquetas, recuperação, suporte, buffers e confiabilidade. A ordem passou a ser verificada automaticamente.

## Prioridade sugerida após a Etapa 2

1. Handoff humano seguro.
2. Recuperação após desligamento/reconexão.
3. Etiquetas com API real e confirmação.
4. `/resetarsys` por conversa.
5. Homologação real antes de substituir a `main`.
