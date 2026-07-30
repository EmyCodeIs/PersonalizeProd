# Módulo fiscal

Este diretório contém o sistema completo de NFS-e incorporado ao `PersonalizeProd`.

## Responsabilidades

- configuração fiscal;
- integração com a Focus;
- emissão, consulta e cancelamento;
- rascunhos e histórico;
- banco SQLite fiscal;
- armazenamento de PDF e XML;
- demonstração, homologação e produção;
- processo interno isolado em `127.0.0.1:3031`.

## Limites

Este módulo não deve:

- alterar mensagens do bot;
- acessar sessões comerciais do atendimento;
- modificar etiquetas ou handoff;
- compartilhar tabelas com o banco operacional do bot;
- encerrar o processo principal quando a Focus falhar.

A interface correspondente fica em `public/fiscal/`.

O arquivo `process.js` inicia o fiscal como processo filho isolado. O painel principal acessa o módulo somente pelo proxy autenticado `/fiscal/*`.

Dados locais:

```text
data/fiscal/personalize-nf.sqlite
storage/fiscal-documents/
```

Esses caminhos são ignorados pelo Git e nunca devem receber tokens, certificados ou documentos versionados.
