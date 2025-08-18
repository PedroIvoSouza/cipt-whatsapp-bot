# CIPT WhatsApp Bot

O bot utiliza um arquivo SQLite chamado `sistemacipt.db` para consultar permissionários e D.A.R.s.

## Banco de dados

- Por padrão o arquivo é procurado no mesmo diretório do código.
- Se o banco estiver em outro caminho ou com outro nome, defina a variável de ambiente `DB_PATH` apontando para o arquivo:
  ```bash
  export DB_PATH=/caminho/para/o/banco.db
  ```
- Antes de iniciar o bot verifique se o arquivo existe e se o usuário possui permissão de leitura:
  ```bash
  ls -l "$DB_PATH"
  ```
  Ajuste as permissões conforme necessário usando `chmod` ou `chown`.

## Executando

```bash
npm start
```
