# Módulo do painel

Este diretório contém somente o backend do painel unificado.

## Pode existir aqui

- autenticação do painel;
- servidor HTTP do painel;
- leitura do estado publicado pelo bot;
- proxy interno para o fiscal;
- rotas administrativas da interface.

## Não pode existir aqui

- mensagens enviadas ao cliente;
- regras de fluxo comercial;
- handoff;
- etiquetas;
- filas ou buffers de conversa;
- regras do WPPConnect além da leitura administrativa do status.

A interface correspondente fica em `public/panel/`.

O ponto de entrada compartilhado apenas chama:

```js
require('./modules/panel/server')
```

Qualquer falha deste módulo deve permanecer isolada e nunca impedir o bot de iniciar.
