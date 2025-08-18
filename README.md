# CIPT WhatsApp Bot

O bot utiliza um arquivo SQLite chamado `sistemacipt.db` para consultar permissionários e D.A.R.s.
Caso você utilize um banco remoto ou não necessite da funcionalidade de pagamentos, essa verificação pode ser ignorada.

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
- Para usar um serviço de banco de dados remoto ou outro tipo de armazenamento, defina `REMOTE_DB_URL` com a URL/DSN correspondente. Quando essa variável estiver presente, o bot não tentará abrir o arquivo SQLite local e iniciará normalmente.
  ```bash
  export REMOTE_DB_URL=https://meu-banco-remoto
  ```
  Caso nenhuma fonte de dados seja encontrada, o bot continuará em execução, mas as consultas de pagamento ficarão indisponíveis.

## Executando

```bash
npm start
```
