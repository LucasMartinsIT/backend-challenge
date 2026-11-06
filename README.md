# Distributed Wagering Processor

Serviço que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) vindas de provedores de jogos, por HTTP e por fila SQS, mantendo o saldo de cada wallet consistente com um ledger imutável, mesmo com mensagens duplicadas, fora de ordem, várias instâncias e quedas no meio do caminho.

NestJS + Bun + TypeScript estrito, MikroORM, PostgreSQL e SQS (LocalStack).

As decisões, os trade-offs e as limitações estão em [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). O enunciado original está em [`docs/CHALLENGE.md`](docs/CHALLENGE.md).

## O que precisa ter instalado

- [Bun](https://bun.sh) 1.x
- Docker com Docker Compose (Postgres e LocalStack rodam em containers)

## Subindo

```bash
docker compose up -d --wait   # Postgres 16 (porta 5433) e LocalStack/SQS (porta 4566)
bun install
bun run migrate:up            # aplica as migrations
bun run dev                   # API em http://localhost:3000 (recarrega ao salvar)
```

O Postgres do compose usa a porta **5433** (e não a 5432) para não brigar com um Postgres local. O script de init do LocalStack cria as filas `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wallet-events.fifo`.

Para rodar sem recarregar: `bun run start`.

### Várias instâncias

A aplicação é pensada para rodar em várias instâncias ao mesmo tempo. Basta mudar a porta:

```bash
PORT=3001 INSTANCE_ID=b bun run start
PORT=3002 INSTANCE_ID=c bun run start
```

Cada instância pode ser só API, só processamento de fila e workers, ou tudo:

| Variável | Efeito |
|---|---|
| `ENABLE_CONSUMER=false` | não consome a fila de apostas |
| `ENABLE_WORKERS=false` | não roda o publicador da outbox nem o worker de referências pendentes |

### Configuração

Tudo tem valor padrão que funciona com o `docker-compose.yml` deste repositório. Veja `.env.example`.

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `3000` | porta HTTP |
| `DATABASE_URL` | `postgres://wagering:wagering@localhost:5433/wagering` | PostgreSQL |
| `AWS_ENDPOINT` | `http://localhost:4566` | LocalStack |
| `WAGER_QUEUE_URL` / `WAGER_DLQ_URL` | filas de apostas e DLQ | consumidor |
| `EVENTS_QUEUE_URL` | `wallet-events.fifo` | destino da outbox |
| `LOG_LEVEL` | `info` | nível dos logs (JSON) |
| `CONSUMER_VISIBILITY_TIMEOUT_SECONDS` | `30` | deve ser igual ao `VisibilityTimeout` da fila |
| `CONSUMER_RETRY_BASE_SECONDS` | `2` | base do backoff do consumidor |
| `OUTBOX_POLL_MS`, `OUTBOX_BATCH_SIZE` | `500`, `50` | publicador da outbox |
| `PENDING_POLL_MS`, `PENDING_MAX_ATTEMPTS`, `PENDING_BASE_DELAY_MS` | `1000`, `12`, `1000` | worker de referências pendentes |

## API

| Método e caminho | Para quê |
|---|---|
| `POST /wallets` | cria wallet (o saldo inicial vira uma transação `OPENING` e um lançamento) |
| `GET /wallets/:walletId` | saldo e `version` |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | extrato paginado (cursor opaco) |
| `POST /wagering/transactions` | submete uma transação (header `Idempotency-Key` obrigatório) |
| `GET /wagering/transactions/:transactionId` | consulta pelo id interno |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | consulta pelo id do provedor |
| `POST /wallets/:walletId/reconciliation` | confere saldo gravado × saldo reconstruído pelo ledger |
| `GET /health/live`, `GET /health/ready` | liveness e readiness (Postgres e SQS) |
| `GET /metrics` | métricas Prometheus |

### Exemplo

```bash
# cria a wallet
curl -s -X POST localhost:3000/wallets -H 'content-type: application/json' \
  -d '{"playerId":"jogador-1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'

# aposta de 25,00 (troque WALLET_ID pelo id devolvido)
curl -s -X POST localhost:3000/wagering/transactions \
  -H 'content-type: application/json' -H 'Idempotency-Key: provider-a:tx-1' \
  -d '{"providerId":"provider-a","externalTransactionId":"tx-1","playerId":"jogador-1",
       "walletId":"WALLET_ID","roundId":"r1","gameId":"fortune-chimp","kind":"BET",
       "money":{"amount":"25.00","currency":"BRL"}}'
```

O mesmo comando de novo devolve `200` com `idempotentReplay: true` e não debita outra vez.

`amount` é sempre **string decimal com até 2 casas** (`"25.00"`). Um número JSON é recusado.

### Status HTTP

| Status | Quando |
|---|---|
| `201` | transação aplicada agora |
| `200` | repetição idêntica (resultado original) |
| `202` | aceita, aguardando a transação referenciada (`PENDING_REFERENCE`) |
| `422` | rejeitada por regra de negócio; o corpo traz `failureCode` |
| `409` | conflito: mesma chave com payload diferente, id externo repetido, wallet duplicada |
| `400` | payload inválido, header ausente, `OPENING`, cursor inválido |
| `404` | recurso inexistente |
| `503` | falha transitória; reenviar com a mesma `Idempotency-Key` (vem `Retry-After`) |

A lista de `failureCode` e o que o provedor deve fazer em cada um está no `ARCHITECTURE.md`.

### Pela fila

Mensagens em `wager-transactions.fifo`, com `MessageGroupId` igual ao `walletId`:

```json
{
  "messageId": "msg-123",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-07-29T15:00:00.000Z",
  "data": {
    "providerId": "provider-a", "externalTransactionId": "transaction-123",
    "idempotencyKey": "provider-a:transaction-123",
    "playerId": "...", "walletId": "...", "roundId": "round-987", "gameId": "fortune-chimp",
    "kind": "BET", "money": { "amount": "25.00", "currency": "BRL" }
  }
}
```

Os eventos de saída (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WagerTransactionPendingReference`, `WalletBalanceChanged`) são publicados em `wallet-events.fifo` pela outbox.

## Testes

```bash
bun run typecheck
bun run test:unit          # não precisa de Docker
bun run test:integration   # precisa do Docker no ar
bun run test:concurrency   # precisa do Docker no ar; sobe processos reais da aplicação
bun test                   # tudo
bun run test:load          # teste de carga com 3 instâncias reais (~1 min); veja docs/LOAD_TEST.md
```

Os testes de integração e de concorrência usam o Postgres e o LocalStack reais do Docker Compose, no banco `wagering_test` (separado do de desenvolvimento). Eles recriam o schema a cada arquivo e criam filas próprias no LocalStack, então não mexem nos seus dados nem nas filas do projeto.

O que cobrem: `Money`, wallet e transições; cada constraint do banco tentando ser violada; as regras de `BET`/`WIN`/`LOSS`/`REFUND`/`ROLLBACK`; idempotência; o cenário de 100,00 com duas apostas de 80,00; 50 requisições idênticas em paralelo; consumo SQS com retry, DLQ e redelivery; outbox com publicadores concorrentes; referências fora de ordem; e, com **processos reais**, 3 instâncias da API, instâncias mortas com `SIGKILL` no meio da carga e reinício. Ao final de cada teste confere-se que o saldo de cada wallet é igual ao saldo reconstruído pelo ledger.

## Migrations

```bash
bun run migrate:up
bun run migrate:down    # desfaz a última
```

## Estrutura

```
src/domain          regras de negócio, sem framework
src/application     casos de uso e portas
src/infrastructure  MikroORM, SQS, workers, métricas, logs
src/interfaces      controllers HTTP, consumidor SQS
migrations          schema versionado, com down()
docker              init do Postgres e do LocalStack
docs                ARCHITECTURE.md e o enunciado
```
