# Correção — sincronização real e conversa da tester

## Evidências do log real

O log do Windows mostrou quatro falhas de ordem e identidade:

1. O sistema publicou `pronto_para_mensagens` antes de o WPPConnect chegar a `CONNECTED`, `MAIN (NORMAL)` e `inChat`.
2. A manutenção das etiquetas foi executada duas vezes enquanto o WA-JS ainda estava sendo injetado, gerando `Minified invariant #56367` nas oito etiquetas.
3. Recuperação e reconciliação começaram antes da sincronização real terminar.
4. A conversa da tester permaneceu bloqueada por um `manual_label` antigo, e `/resetarsys` foi descartado porque `ENABLE_TEST_COMMANDS=false`.

Também apareceu um alias inválido `[object object]`, causado pela normalização de objetos de identidade como texto.

## Correções aplicadas

### Barreira de sincronização

`src/core/synchronizationGuardPreload.js` passa a bloquear o retorno da criação do canal até que sejam verdadeiros ao mesmo tempo:

- estado de conexão operacional (`CONNECTED`, `MAIN`, `NORMAL` ou `inChat`);
- documento completamente carregado;
- objeto `window.WPP` disponível;
- API de chat disponível;
- `Store.Chat` disponível.

A manutenção de etiquetas aguarda adicionalmente `WPP.labels.getAllLabels` e `WPP.lists.create`.

`SYNCING` e `RESUMING` não são mais tratados como estados conectados para recuperação.

### Etiquetas

A criação/conferência obrigatória usa uma promessa única por cliente. Chamadas simultâneas ou repetidas compartilham o mesmo resultado e não executam a criação duas vezes.

Se a API não ficar disponível no prazo, a conferência complementar é adiada e não tenta operar em uma API incompleta.

### Tester

A identidade administrativa aceita, em ordem:

1. `TEST_COMMAND_*` quando preenchidas;
2. `ADMIN_WHATSAPP_NUMBERS` e `ADMIN_WHATSAPP_CHAT_IDS` do `.env` atual;
3. whitelist geral como fallback.

Para a tester autorizada:

- mensagem manual não ativa handoff;
- etiqueta manual ou de vendedor não bloqueia a automação;
- bloqueio antigo é removido ao receber a próxima mensagem;
- `/resetarsys` funciona mesmo com `ENABLE_TEST_COMMANDS=false`;
- `/reset` e `/reiniciar` continuam dependentes de `ENABLE_TEST_COMMANDS=true`;
- `/resetarsys` limpa somente sessão, perfil, buffers, fila, atividade e handoff da própria conversa.

### Identidade

Objetos com `_serialized` ou `id._serialized` são resolvidos corretamente. Objetos desconhecidos deixam de virar o alias inválido `[object object]`.

## Ordem esperada no próximo teste real

```text
CONEXÃO · evento=estado_alterado · status=CONNECTED
CONEXÃO · evento=sincronização_concluída · status=pronto
[SINCRONIZAÇÃO] transporte e APIs principais prontos
[LISTAS][INÍCIO] conferindo 8 etiquetas obrigatórias uma única vez...
ETIQUETA · evento=inicialização_concluída · resultado=ok
RECUPERAÇÃO · evento=reconciliação_de_etiquetas_iniciada
RECUPERAÇÃO · evento=respostas_pendentes_iniciada
SISTEMA · evento=pronto_para_mensagens · status=pronto
```

Não pode voltar a aparecer criação de etiquetas antes da mensagem `[SINCRONIZAÇÃO]`.

## Resultado esperado do `/resetarsys`

```text
[COMANDO TESTE] administrador autorizado | comando=/resetarsys
ADMIN · evento=resetarsys_limpeza_local · resultado=ok
HANDOFF · evento=tester_liberada · status=livre
ENVIO · evento=concluído · tipo=texto · confirmado=sim
```

Resposta no WhatsApp:

```text
Sistema resetado para teste.

Conversa zerada para teste. Envie uma nova mensagem para começar como primeiro contato.
```

## Preservado

- textos, menus, listas e assets comerciais;
- sequência do fluxo de orçamento;
- regras de handoff para clientes normais;
- regras de etiquetas para clientes normais;
- recuperação para clientes normais, exceto a ordem segura de execução;
- delays, digitação, concorrência e limites existentes.
