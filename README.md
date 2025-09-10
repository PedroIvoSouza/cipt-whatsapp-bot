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

## Sistema de pagamento

Algumas funcionalidades de integração exigem parâmetros fornecidos pelo sistema de pagamento utilizado pelo CIPT. As variáveis de ambiente a seguir devem ser configuradas antes da inicialização do bot:

- `BOT_SHARED_KEY` – chave secreta compartilhada usada para validar requisições.
- `ADMIN_API_BASE` – URL base da API administrativa do sistema de pagamento.
- `ADMIN_PUBLIC_BASE` – URL pública utilizada para redirecionamentos e callbacks.

Esses valores podem ser obtidos no painel do sistema de pagamento, normalmente na seção de integrações ou configurações de API. Gere ou copie a chave compartilhada e copie as URLs base dos ambientes de administração e público fornecidas pelo serviço.

Exemplo de configuração em um ambiente Unix:

```bash
export BOT_SHARED_KEY="minhaChaveSecreta"
export ADMIN_API_BASE="https://pagamentos.exemplo.com/api/admin"
export ADMIN_PUBLIC_BASE="https://pagamentos.exemplo.com"
```

Certifique-se de manter a chave compartilhada em local seguro e não versioná-la.

## Envio de mensagens via API

O bot expõe um endpoint HTTP que permite o envio de mensagens de texto para um número do WhatsApp.

### `POST /send`

Envia uma mensagem para o número especificado.

**Cabeçalhos**

- `Authorization: Bearer <WHATSAPP_BOT_TOKEN>`
- `Content-Type: application/json`

**Exemplo de requisição**

```bash
curl -X POST http://localhost:3000/send \
  -H "Authorization: Bearer supersecreto" \
  -H "Content-Type: application/json" \
  -d '{"to":"5582999999999","message":"Olá!"}'
```

**Resposta**

```json
{ "success": true }
```

### Variáveis de ambiente

```
WHATSAPP_BOT_TOKEN=supersecreto
#BOT_AUTH_DEBUG=true
```

`WHATSAPP_BOT_TOKEN` define o token aceito pelo middleware de autenticação. Defina `BOT_AUTH_DEBUG` como `true` para habilitar logs de depuração.

## Executando

```bash
npm start
```
