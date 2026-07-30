# Módulo fiscal de NFS-e

Este diretório contém o sistema fiscal dentro do mesmo repositório `PersonalizeProd`, mas sem alterar ou participar da inicialização do bot.

## Responsabilidades

- integração com a Focus;
- emissão, consulta e cancelamento de NFS-e;
- notas emitidas, rascunhos e histórico;
- banco SQLite fiscal próprio;
- armazenamento de PDF e XML;
- demonstração, homologação e produção protegida.

## Limite obrigatório

Este módulo não pode:

- alterar mensagens, logs ou inicialização do bot;
- acessar a conexão ou a sessão do WPPConnect;
- modificar fluxo, fila, buffer, etiquetas ou handoff;
- compartilhar tabelas com o banco operacional do atendimento;
- ser iniciado pelo comando `npm start`.

## Execução isolada

Dentro da pasta principal do projeto:

```powershell
npm run fiscal:start
```

Acesse:

```text
http://127.0.0.1:3031
```

O `npm start` continua iniciando somente o sistema existente da Personalize.

## Dados locais

```text
data/fiscal/personalize-nf.sqlite
storage/fiscal-documents/
```

Esses caminhos são ignorados pelo Git. Tokens e documentos fiscais permanecem apenas no `.env` e nas pastas locais.
