# Manutenção de etiquetas corrompidas

A manutenção roda uma única vez quando o canal do WhatsApp fica disponível. Falhas nessa rotina são isoladas e não interrompem o atendimento.

## O que é considerado corrompido

O sistema marca como corrompida uma etiqueta que tenha pelo menos uma destas condições:

- nome vazio ou composto apenas por espaços;
- caractere de substituição `�` (`U+FFFD`);
- caracteres invisíveis ou de controle;
- sequência Unicode inválida, como surrogate sem par;
- caracteres Unicode reservados como noncharacters;
- nome composto apenas por pontuação ou símbolos, como `???`, `###` ou `——`.

## O que é preservado

- nomes que contenham letras ou números;
- etiquetas com texto e emoji, como `Fornecedor ⚠️`;
- etiquetas compostas somente por emoji, como `🔥`;
- etiquetas operacionais e de vendedor com nomes válidos.

## Configuração

Somente auditar, sem apagar:

```env
LABEL_MAINTENANCE_ENABLED=true
LABEL_MAINTENANCE_AUTO_REMOVE_CORRUPT_SYMBOLS=false
LABEL_MAINTENANCE_CONFIRM_DELETE=
```

Ativar a exclusão automática confirmada:

```env
LABEL_MAINTENANCE_ENABLED=true
LABEL_MAINTENANCE_AUTO_REMOVE_CORRUPT_SYMBOLS=true
LABEL_MAINTENANCE_CONFIRM_DELETE=CONFIRMAR_EXCLUSAO
```

A confirmação é compartilhada com a limpeza de etiquetas duplicadas. Sem o valor exato `CONFIRMAR_EXCLUSAO`, o sistema força a remoção para `false` e apenas registra a auditoria.

## Logs

Procurar por:

```text
[LISTAS][SÍMBOLOS] etiqueta corrompida encontrada
[LISTAS][SÍMBOLOS] etiqueta corrompida removida
[LISTAS][SÍMBOLOS] falha ao remover etiqueta corrompida
[LISTAS][SÍMBOLOS] auditoria concluída
```

Na VPS:

```bash
pm2 logs personalize-wppconnect --lines 500 | grep -Ei "LISTAS.*SÍMBOLOS|corrompida"
```

Cada exclusão é feita pelo ID e só é considerada concluída depois que o sistema relê as etiquetas do WhatsApp e confirma que o ID desapareceu.
