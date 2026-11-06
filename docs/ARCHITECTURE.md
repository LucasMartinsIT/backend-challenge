# Arquitetura

Este documento explica o que construí, por que escolhi cada coisa e onde eu sei que há limites. A ordem segue o que o desafio avalia: dinheiro, concorrência, idempotência, mensageria, e só depois o resto.

## 1. Visão geral

```
                 HTTP (N instâncias)                      SQS wager-transactions.fifo
  provedor ─────────────┐                                           │
                        ▼                                           ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │  SubmitWagerTransaction  (o mesmo caso de uso nas duas  │
                 │  entradas)                                              │
                 │   1. inbox (só SQS)                                     │
                 │   2. SELECT ... FOR UPDATE na wallet                    │
                 │   3. idempotência (chave + hash do payload)             │
                 │   4. regras de negócio                                  │
                 │   5. transação + ledger + saldo + outbox                │
                 └──────────────────────────┬──────────────────────────────┘
                                            │  uma única transação SQL
                                            ▼
                                       PostgreSQL
                                            │
              ┌─────────────────────────────┼──────────────────────────────┐
              ▼                             ▼                              ▼
     publicador da outbox          worker de PENDING_REFERENCE       reconciliação
     (SKIP LOCKED) ──► SQS wallet-events.fifo
```

Tudo o que muda dinheiro passa por um único caso de uso. HTTP e SQS são só adaptadores de entrada, então as regras e as garantias são as mesmas nos dois caminhos (há um teste que manda a mesma transação pelos dois ao mesmo tempo, em instâncias diferentes, e confere que o efeito é um só).

### Camadas

```
src/
  domain/          regras puras: Money, Wallet, WagerTransaction, ledger, inbox, outbox, eventos.
                   Não importa Nest nem MikroORM.
  application/     casos de uso e as portas (interfaces) que eles precisam.
  infrastructure/  MikroORM, repositórios, SQS, workers, métricas, logs, health.
  interfaces/      controllers HTTP, consumidor SQS, serviços que sobem os workers.
migrations/        Migrations do MikroORM, com up() e down().
test/              unit, integration, concurrency (inclui processos reais), load.
```

Quis o domínio sem framework porque as invariantes (saldo nunca negativo, ledger coerente, transições de estado) são o que mais importa e o que mais precisa ser testado sem depender de banco.

## 2. Escolhas de stack

| Item | Escolha | Por quê |
|---|---|---|
| ORM | **MikroORM 6** | É o preferencial do desafio e tem o que eu precisava de forma explícita: `EntityManager.transactional()` e `LockMode.PESSIMISTIC_WRITE`. |
| Mapeamento | `EntitySchema` (sem decorators) | Mantém as classes de domínio livres de ORM. O registro de persistência é separado e o mapper usa `rehydrate`. |
| Dinheiro no banco | `NUMERIC(20,2)` + coluna `currency CHAR(3)` | Exato. O driver devolve `numeric` como string, então o valor nunca passa por `number`. |
| SQL direto | ledger, inbox, outbox, locks com `SKIP LOCKED`, agregações | São tabelas append-only com `ON CONFLICT`, `jsonb` e aritmética em `numeric`. Ali o SQL ficou mais claro e mais seguro que o ORM. |
| Migrations | Rodadas por `src/infrastructure/mikro-orm/migrate.ts` | A CLI do MikroORM não se dá bem com o Bun. O runner programático usa o mesmo `Migrator`, com a lista de migrations explícita. |
| Validação de entrada | zod | `amount` precisa ser string; um número JSON é recusado antes de virar dinheiro. |

**Estratégia transacional.** Toda operação roda em `UnitOfWork.run()`, que abre uma transação com `em.fork().transactional()`. Dentro dela eu uso `set local lock_timeout = '2s'`. Deadlock (`40P01`), falha de serialização (`40001`) e lock timeout (`55P03`) são repetidos até 3 vezes, com um pequeno jitter. Cada tentativa é uma transação nova com tudo recalculado, então não há efeito vazando entre tentativas.

## 3. Dinheiro (`Money`)

- Valor guardado como **centavos em `bigint`**. Nenhuma etapa usa `number`, `float` ou `double`.
- Entrada só aceita `^\d+(\.\d{1,2})?$`: rejeita vazio, `NaN`, `Infinity`, notação científica, sinal, vírgula e mais de 2 casas. `"25"` e `"25.5"` viram `"25.00"` e `"25.50"`.
- Saída sempre com 2 casas (`"25.00"`).
- Imutável: toda operação devolve uma nova instância. Operar moedas diferentes lança erro de domínio.
- O modelo é multi-moeda. Na prática os testes usam BRL, e o conflito de moeda é testado (aposta em USD numa wallet BRL é rejeitada com `CURRENCY_MISMATCH`).
- Resultados intermediários podem ser negativos (`subtract`, `negate`), mas **não podem entrar** por `Money.from`. A reidratação do banco usa um caminho próprio para somas do ledger.

## 4. Modelo e transições de estado

`WagerTransaction` nasce `PENDING`. Os estados `PROCESSED`, `REJECTED` e `FAILED` são terminais.

| De | Para | Quando |
|---|---|---|
| `PENDING` | `PROCESSED` | regras ok, saldo e ledger aplicados |
| `PENDING` | `REJECTED` | violação de regra de negócio |
| `PENDING` | `PENDING_REFERENCE` | REFUND/ROLLBACK/WIN/LOSS cuja referência ainda não chegou |
| `PENDING` | `FAILED` | erro permanente nosso (auditável) |
| `PENDING_REFERENCE` | `PENDING_REFERENCE` | nova tentativa do worker, continua esperando |
| `PENDING_REFERENCE` | `PROCESSED` / `REJECTED` / `FAILED` | a referência apareceu, o prazo acabou ou o reprocessamento falhou de vez |

Tentar transicionar a partir de um estado terminal lança `InvalidTransactionStateError`: é erro de programação, não um caminho de negócio.

Na prática, a transação é decidida de uma vez dentro da transação SQL e gravada já no estado final; `PENDING` em memória é só o ponto de partida. Os estados persistidos que o resto do sistema vê são `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` e `FAILED`.

`OPENING` é interno. A factory pública `create` o recusa, e só `createOpening` o cria, usada na criação da wallet. Por HTTP ou fila ele responde 400 (ou vai para a DLQ).

`Wallet.debit/credit` devolvem o lançamento do ledger e mudam saldo e `version` no mesmo método. Não existe caminho para alterar o saldo sem produzir o lançamento. A `version` começa em 1 e só sobe quando o saldo muda.

`WalletLedgerEntry` não tem setter nem método de transição, e a factory confere `balanceBefore ± valor = balanceAfter`.

## 5. Schema: o que o banco garante sozinho

O desafio pede que unicidade, imutabilidade e não-negatividade estejam no schema. Estão. Mesmo que um bug no código tente violar, o banco recusa.

| Garantia | Mecanismo |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` |
| Uma wallet por jogador e moeda | `UNIQUE (player_id, currency)` |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Valor positivo | `CHECK (amount > 0)` na transação e no ledger |
| REFUND/ROLLBACK têm referência | `CHECK` sobre `kind` e `reference_external_transaction_id` |
| Rejeição tem motivo | `CHECK (status NOT IN ('REJECTED','FAILED') OR failure_code IS NOT NULL)` |
| Reversão processada aponta para o alvo | `CHECK` sobre `reference_transaction_id` |
| **Uma transação só é revertida uma vez** | índice único parcial `wager_tx_single_reversal` em `reference_transaction_id` onde `status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')` |
| Aritmética do ledger coerente | `CHECK` por direção: `balance_before ± amount = balance_after` |
| Um lançamento por (wallet, transação) | `UNIQUE (wallet_id, transaction_id)` |
| **Ledger imutável** | trigger `BEFORE UPDATE OR DELETE` por linha e `BEFORE TRUNCATE` que lançam exceção |
| Inbox sem duplicata | `PRIMARY KEY (consumer_name, message_id)` |

Cada uma dessas constraints tem um teste que tenta violá-la direto no banco e confere o erro e o nome da constraint.

Índices parciais atendem as consultas dos workers: transações `PENDING_REFERENCE` por `next_attempt_at` e eventos da outbox ainda não publicados.

## 6. Concorrência

**A unidade de concorrência é a wallet.** Escolhi **lock pessimista por linha**: dentro da transação, `SELECT ... FOR UPDATE` na wallet (via `LockMode.PESSIMISTIC_WRITE`), antes de qualquer decisão.

Por que não as outras opções:

- **Otimista com `version` e retry.** Funciona, mas numa wallet muito disputada a maioria das tentativas falha e refaz tudo (inclusive consultas de idempotência e referência). A taxa de retry cresce justamente onde há mais carga.
- **Update atômico condicionado** (`UPDATE ... SET balance = balance - x WHERE balance >= x`). É excelente para o saldo isolado, mas o fluxo aqui precisa decidir várias coisas juntas com o saldo: idempotência, referência, reversão já feita, ledger com `balance_before`/`balance_after`. Com o lock da wallet tudo isso fica serializado sem raciocínio extra.

O lock também é o que **serializa duplicatas**: 50 requisições idênticas chegam a instâncias diferentes, uma pega o lock, grava; as outras esperam e, ao entrar, encontram a transação pela chave e devolvem o resultado original.

Garantias redundantes, pensadas para o caso de o lock falhar ou de um worker novo esquecer de pegá-lo: `saveBalance` faz `UPDATE ... WHERE version = esperada` (se não afetar uma linha, lança `StaleWalletVersionError`), e o banco tem `CHECK (balance >= 0)` e as uniques.

**Trade-off assumido.** Uma "hot wallet" é serializada: o throughput dela é o de uma transação curta por vez. Escolhi correção em vez de paralelismo dentro da mesma wallet, que é o que o desafio pede. Wallets diferentes andam em paralelo, sem lock compartilhado.

**Ordem de locks.** O fluxo de submissão e o worker de pendências tomam sempre wallet → depois linha da transação. O fluxo de submissão não trava linhas existentes de `wager_transactions`, então não há ciclo de espera.

**Isolamento.** `READ COMMITTED` (padrão). Funciona porque toda leitura que importa acontece depois do lock da wallet, e quem ganhou o lock já viu os commits anteriores.

**Reconciliação sem lock.** `POST /wallets/:id/reconciliation` lê saldo gravado e soma do ledger num **único statement**, que enxerga um snapshot consistente. Assim não bloqueia escritas nem acusa divergência falsa no meio de uma transação.

## 7. Idempotência

Fluxo, tudo na mesma transação SQL:

1. (SQS) `INSERT` na inbox com `ON CONFLICT DO NOTHING`.
2. Lock da wallet.
3. Busca por `idempotency_key`. Se existe com o mesmo hash, é **replay**: devolve o resultado original. Se o hash difere, é **conflito** e nada é gravado.
4. Busca por `(provider_id, external_transaction_id)`: se existe com outra chave, é conflito.
5. Caso contrário aplica as regras e grava.

As uniques são a rede de segurança. Se duas requisições com a mesma chave caírem em wallets diferentes (payloads diferentes, logo sem o lock em comum), o banco derruba uma por `23505` e o caso de uso repete a execução uma vez, encontrando a vencedora.

**Hash do payload.** SHA-256 do JSON canônico (chaves ordenadas recursivamente, sem espaços, `undefined` descartado) dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` (`amount` e `currency`) e `referenceExternalTransactionId`. O header `Idempotency-Key` e metadados de transporte ficam de fora.

**Replay devolve o resultado original**, incluindo o saldo observado naquele momento: gravo `balance_after` junto da transação. Há um teste que faz uma aposta, muda o saldo com outra, e confere que o replay da primeira ainda mostra o saldo da época.

**Inbox × idempotência.** A inbox deduplica a *mensagem* (`consumer_name`, `message_id`); a chave de idempotência deduplica a *transação*. São camadas diferentes: a mesma transação pode chegar em mensagens distintas. Na inbox guardo o hash do conteúdo da mensagem; se o mesmo `messageId` reaparece com conteúdo diferente, é erro permanente e vai para a DLQ.

## 8. Regras de negócio e interpretações

As regras seguem a tabela do desafio. Onde o texto deixou espaço, decidi assim:

1. **Reversão única de qualquer tipo.** A regra 4 diz que uma referência não pode ser revertida duas vezes "pelo mesmo tipo de operação". Lida ao pé da letra, `BET` + `REFUND` + `ROLLBACK` devolveria o valor duas vezes, o que é crédito duplicado. Adotei a leitura mais estrita: **cada transação `PROCESSED` só pode ser revertida uma vez, por REFUND ou por ROLLBACK**. É garantida no banco pelo índice parcial `wager_tx_single_reversal`. Um `ROLLBACK` de um `REFUND` é permitido porque o alvo é o próprio REFUND, que ainda não foi revertido.
2. **Referências válidas por tipo.** `REFUND` só referencia `BET`. `ROLLBACK` referencia `BET`, `WIN` ou `REFUND`. `WIN` e `LOSS` podem referenciar uma `BET` (opcional). `BET` não referencia nada.
3. **A referência precisa estar no mesmo contexto:** mesmo provedor, jogador, wallet, moeda e rodada (`REFERENCE_MISMATCH` se não estiver).
4. **Valor de REFUND/ROLLBACK igual ao da referência.** Reversão parcial está fora de escopo.
5. **ROLLBACK de WIN ou de REFUND é débito** e pode falhar por saldo: nesse caso a rejeição é `REVERSAL_INSUFFICIENT_FUNDS`, diferente de `INSUFFICIENT_FUNDS` (aposta sem saldo).
6. **WIN/LOSS sobre uma BET já revertida** são rejeitados com `REFERENCE_ALREADY_REVERSED`. Sem isso, um WIN poderia creditar sobre uma aposta cancelada.
7. **Rejeições são gravadas** (status `REJECTED`, `failure_code`, saldo observado) e geram o evento `WagerTransactionRejected`. Não geram lançamento.
8. **Wallet inexistente não é gravada.** A transação tem chave estrangeira para a wallet, então não há onde gravá-la. A API responde 404 e a mensagem SQS é confirmada. Essa é a única rejeição sem trilha de auditoria (ver limitações).
9. **Jogador diferente do dono da wallet** é rejeitado e gravado (`WALLET_PLAYER_MISMATCH`).

## 9. Códigos de falha

Estáveis e legíveis por máquina. A coluna da direita diz o que o provedor deve fazer.

| `failureCode` | Significa | O provedor deve |
|---|---|---|
| `INSUFFICIENT_FUNDS` | aposta maior que o saldo | não reenviar; encerrar a rodada |
| `REVERSAL_INSUFFICIENT_FUNDS` | a reversão deixaria o saldo negativo | tratar como caso operacional |
| `CURRENCY_MISMATCH` | moeda diferente da wallet | corrigir o payload |
| `WALLET_PLAYER_MISMATCH` | jogador não é dono da wallet | corrigir o payload |
| `REFERENCE_NOT_FOUND` | a referência não apareceu dentro do prazo | verificar se a transação original foi enviada |
| `REFERENCE_MISMATCH` | referência de outra rodada, wallet, jogador ou moeda | corrigir o payload |
| `REFERENCE_KIND_NOT_ALLOWED` | tipo de referência inválido para esta operação | corrigir o payload |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada ou falhou | não há o que reverter |
| `REFERENCE_ALREADY_REVERSED` | a referência já foi revertida | considerar concluído |
| `REFERENCE_AMOUNT_MISMATCH` | valor diferente do da referência | corrigir o payload |
| `INTERNAL_PERMANENT_ERROR` | erro permanente nosso; fica só para auditoria | contatar a operação |

## 10. API HTTP: um status por situação

O mapeamento é o mesmo em todos os endpoints.

| Situação | Status |
|---|---|
| Transação aplicada agora | **201** |
| Replay idêntico | **200** (`idempotentReplay: true`) |
| Aceita, aguardando a referência | **202** (`PENDING_REFERENCE`) |
| Rejeição por regra de negócio | **422** (com `failureCode`) |
| `FAILED` (terminal, auditável) | **422** |
| Conflito de idempotência / id externo / wallet duplicada | **409** |
| Payload inválido, header ausente, `OPENING`, cursor inválido | **400** |
| Recurso inexistente | **404** |
| Falha transitória de infraestrutura | **503** com `Retry-After` |

Assim o provedor decide sem ler mensagem: 2xx terminou ou está em andamento, 4xx não adianta reenviar sem mudar algo (409 e 422 são definitivos, 400 pede correção), 503 pode reenviar a mesma requisição com a mesma chave.

Erros usam o corpo `{ "error": { "code", "message" } }`. A rejeição de negócio devolve também `transactionId`, `status`, `failureCode` e o saldo.

## 11. Consumidor SQS

Filas: `wager-transactions.fifo` (com DLQ), `wager-transactions-dlq.fifo` e `wallet-events.fifo` (saída da outbox).

**Ack só depois do commit.** O handler chama o caso de uso e só então o consumidor faz `DeleteMessage`.

**Quatro destinos para cada mensagem:**

| Resultado | Exemplos | O que faz |
|---|---|---|
| Confirma (ack) | aplicada, rejeitada por regra, replay, wallet inexistente, conflito de idempotência | `DeleteMessage` |
| Retry com backoff | falha de infraestrutura, erro inesperado | `ChangeMessageVisibility` com 2s, 4s, 8s... até 300s |
| DLQ direta, com o motivo | JSON quebrado, tipo desconhecido, `OPENING`, dinheiro inválido, mesmo `messageId` com outro conteúdo | `SendMessage` à DLQ com o atributo `failureReason`, depois `DeleteMessage` |
| Redrive da fila | esgotou os recebimentos | a fila move para a DLQ |

**Limite de tentativas.** `maxReceiveCount = 10`. Com o backoff acima, isso cobre cerca de 13 minutos de indisponibilidade do banco antes de uma mensagem ir para a DLQ. Comecei com 5, que levava uma mensagem à DLQ em cerca de 30 segundos, o que é pouco para um Postgres reiniciando; subi depois de uma revisão.

**Ordem FIFO.** Mensagens do mesmo grupo (a wallet) são processadas em sequência; grupos diferentes em paralelo. Se a mensagem da frente do grupo precisa de retry, as seguintes ficam escondidas pelo mesmo tempo do backoff e voltam juntas, em ordem. Devolvê-las imediatamente destravaria o grupo antes da hora.

**Visibilidade.** Se o lote passa de 60% do `VisibilityTimeout` esperando a vez, o resto do grupo é devolvido, para a fila não entregá-lo a outra instância enquanto ele ainda está na memória desta.

**Shutdown.** Ao receber o sinal, o consumidor para de buscar, deixa terminar o que já começou (com timeout) e devolve o resto com visibilidade 0.

**O que não confio no broker.** O SQS FIFO ajuda, mas as invariantes vêm do banco: a inbox e a chave de idempotência sozinhas já bastam para que redelivery e duplicata não dupliquem efeito.

## 12. Outbox transacional

O evento é gravado na **mesma transação** da alteração financeira, então só existe se ela for confirmada (o teste de rollback confere que um erro no meio não deixa evento órfão).

**Publicador.** Seleciona eventos pendentes e vencidos com `FOR UPDATE SKIP LOCKED`, envia ao SQS e marca como publicado, tudo numa transação. Vários publicadores rodam juntos sem pegar a mesma linha. Se um destino falha, o evento é reagendado com backoff (1s, 2s, 4s... até 60s). Depois de 20 falhas (cerca de 15 minutos), o evento é **abandonado** (`failed_at`): sai da fila de entrega, fica gravado e é contado à parte, para um evento que o destino sempre recusa não ficar tentando para sempre nem inflar a métrica de lag.

**O cenário do enunciado.** O Postgres confirma, o processo morre antes de publicar, outra instância assume, publica, e uma duplicata continua segura:

- Morte antes de publicar: o evento continua `published_at IS NULL`; outra instância o pega.
- Morte depois de enviar e antes do commit do publicador: o evento será reenviado. O `MessageDeduplicationId` é o `eventId`, e a fila FIFO descarta a repetição dentro da janela de 5 minutos. Fora dela, o consumidor deduplica pelo `eventId`.

Há testes para os dois casos. A morte entre o envio e o commit é simulada com uma falha injetada no meio do publicador; já nos testes com processos reais mortos por `SIGKILL` (seção 16) confiro que cada evento chega à fila de saída exatamente uma vez.

**Se a conexão sumir no meio do envio**, a sessão ficaria "idle in transaction" com as linhas travadas. O publicador define `idle_in_transaction_session_timeout = 30s`, então o Postgres derruba a sessão e libera as linhas.

**Eventos.** `WagerTransactionProcessed` (qualquer transação aplicada, inclusive `LOSS`), `WagerTransactionRejected`, `WagerTransactionPendingReference` e `WalletBalanceChanged` (somente quando o saldo muda). O envelope é uma classe abstrata com `eventType` e `version` no tipo, e o payload leva dinheiro como `MoneyProps` (string decimal), nunca a instância de `Money`.

**Ordem dos eventos.** Dentro de um lote, os eventos de uma mesma wallet saem em sequência e, se um falha, os seguintes esperam. **Entre publicadores diferentes a ordem global não é garantida.** Isso é um limite consciente (seção 17). Para o consumidor ordenar e deduplicar, o envelope traz `eventId` e `WalletBalanceChanged` traz `walletVersion`.

## 13. Referências fora de ordem

Um `REFUND`, `ROLLBACK`, `WIN` ou `LOSS` pode chegar antes da transação que referencia. Nesse caso ele é gravado como `PENDING_REFERENCE` (HTTP 202) com o evento `WagerTransactionPendingReference`, e um **worker agendado** o reavalia.

- **Backoff.** O primeiro reprocessamento é 1s depois; depois 2s, 4s, 8s, 16s, 32s e 60s (teto).
- **Limite: 12 tentativas, cerca de 7 minutos.** Escolhi esse prazo porque cobre um atraso realista de entrega e de reordenação entre filas sem deixar uma transação pendente indefinidamente. Passado o limite, a transação vira `REJECTED` com `REFERENCE_NOT_FOUND` e o evento `WagerTransactionRejected` é publicado.
- **Várias instâncias.** O worker toma o lock da wallet, **relê a pendente só se ainda estiver vencida** e então reaplica as regras (a mesma função `applyTransaction` da submissão). Sem a releitura condicional, três instâncias gastariam três tentativas no mesmo vencimento e rejeitariam cedo demais; isso foi achado numa revisão e tem teste.
- **Candidata com defeito.** Um erro ao reprocessar uma pendente conta como tentativa e ela é reagendada; as demais seguem. Esgotado o limite, vira `FAILED` (`INTERNAL_PERMANENT_ERROR`).
- **Latência.** Depois que a referência chega, a pendente é resolvida na próxima vez que o worker olhá-la, até 60s depois. Aceitei isso para não acoplar a chegada de uma transação ao reprocessamento de outras.

## 14. Observabilidade

**Logs.** JSON via `nestjs-pino`, com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` e `instance`. O `correlationId` vem do header `x-correlation-id` (validado) ou é gerado, e é devolvido na resposta. Cada transação tratada gera uma linha `wager.handled`.

Sem dado sensível: o log HTTP não leva cabeçalhos nem corpo, e **nenhum log leva valores monetários**. Mensagens de erro de banco costumam trazer o SQL com os valores dos parâmetros; por isso `safeErrorSummary` mostra só nome, código SQLSTATE e constraint nesses casos. Há um teste que sobe um servidor HTTP real com a configuração de log e confere que token, cookie e montante não aparecem.

**Métricas** (`GET /metrics`, Prometheus): `wager_transactions_total{status,kind}`, `idempotent_replays_total`, `inbox_duplicates_total`, `sqs_retries_total`, `sqs_dlq_total`, `sqs_acks_total`, `lock_conflicts_total`, `outbox_lag_seconds`, `outbox_pending`, `outbox_failed`, `outbox_published_total`, `outbox_abandoned_total`, `wager_processing_seconds` (histograma), `pending_reference_resolutions_total`, `reconciliation_mismatches_total`, `wager_request_errors_total{code}`, além das métricas padrão do processo. As gauges da outbox são lidas do banco na hora do scrape (com cache de 1s). Uma repetição conta em `idempotent_replays_total` e não em `wager_transactions_total`. Os ganchos rodam depois do commit, então tentativas que sofreram rollback não entram na conta.

**Health.** `/health/live` não consulta dependência nenhuma (uma queda do banco não deve reiniciar o processo à toa). `/health/ready` confere Postgres e SQS, cada um com timeout, e responde 503 se algum falhar. Os dois são públicos.

## 15. Autenticação

Não implementei, como o desafio permite (não vale pontos e não deve competir com o resto). O ponto de extensão está explícito: `AuthGuard` global em `src/interfaces/http/auth.guard.ts`, hoje no-op, com `@Public()` nos endpoints de health e métricas.

**O desenho que eu adotaria:** um Identity Provider externo (Keycloak), com *client credentials* por provedor de jogos. O guard validaria o JWT (assinatura via JWKS, `iss`, `aud`, `exp`) e compararia um claim `provider_id` com o `providerId` do payload, recusando com 403 quando não batem. Nada de tabela de usuários nem hash de senha na aplicação. Mensagens vindas da fila continuam sendo canal interno confiável, como o desafio define, mas a identidade do provedor no conteúdo segue sujeita às mesmas validações de domínio.

## 16. Testes

Rodam com `bun test`. A suíte de integração e a de concorrência usam **PostgreSQL e LocalStack reais** (os do Docker Compose), sem mocks de infraestrutura.

| Grupo | O que cobre |
|---|---|
| `test/unit` | `Money`, `Wallet`, transições, ledger imutável, hash canônico, backoff, classificação de mensagens SQS, runner periódico, logs e métricas |
| `test/integration` | migrations `up/down/up`, cada constraint tentando ser violada, repositórios, atomicidade e rollback, regras de negócio, HTTP, consumidor SQS, outbox, pendências |
| `test/concurrency` | paralelismo real: cenário 100/80/80, 50 requisições idênticas, hot wallet, reversões simultâneas |
| `test/load` | `bun run test:load`: carga com 3 instâncias reais, mede latência, erros, lock e lag da outbox (`docs/LOAD_TEST.md`) |
| `test/concurrency/multi-instance` | **processos reais** da aplicação: 3 instâncias HTTP, 3 consumidores com uma instância morta por `SIGKILL`, queda total e reinício, pendências resolvidas por workers, a mesma transação por HTTP e SQS |

O invariante `wallet.balance == saldo reconstruído pelo ledger` é conferido ao final de cada teste de concorrência e, nos testes com várias instâncias, em todas as wallets do banco de uma vez.

**Os testes detectam a falha de verdade.** Fiz dois testes de mutação à mão: tirando o `FOR UPDATE` da wallet, 5 dos 8 testes de concorrência falham (inclusive o cenário 100/80/80); tirando o `SKIP LOCKED` da outbox, o teste de publicadores concorrentes falha (240 envios em vez de 60). Desfeitas as alterações, tudo passa.

**Determinismo.** A suíte inteira passa em rodadas seguidas. Nos testes com filas uso filas próprias por execução (nome único), para não colidir com as filas do projeto nem com a aplicação rodando ao mesmo tempo.

## 17. Limitações e riscos que conheço

- **Hot wallet serializa.** É uma consequência direta da escolha pelo lock pessimista.
- **A vazão do publicador da outbox ficou abaixo da produção de eventos no teste de carga** (lag de ~14 s no pico, 27 s para esvaziar; veja `docs/LOAD_TEST.md`). Os eventos não se perdem, mas o atraso existe. Ele é consequência, pelo menos em parte, de enviar em sequência os eventos de uma mesma wallet para manter a ordem. Aumentar o lote não ajudou.
- **Ordem global dos eventos da outbox não é garantida entre publicadores diferentes.** Garanti-la custaria um evento por wallet por ciclo de publicação. O desafio trata a ordem do broker como otimização, então deixei para o consumidor usar `walletVersion` e `eventId`. Os eventos `WagerTransaction*` não têm número de sequência; um consumidor que aplique "o último vence" pode regredir um estado. Eles devem seguir "estado terminal vence".
- **Wallet inexistente não deixa trilha de auditoria** (seção 8).
- **O banco não garante sozinho que `wallets.balance` bate com o último `balance_after` do ledger.** Quem garante é o código, dentro do lock, e a reconciliação detecta divergência. Uma evolução possível é um trigger deferred.
- **O publicador mantém uma transação aberta durante o envio ao SQS.** Mitigado pelo timeout de sessão ociosa e pelo timeout de 5s por envio, mas continua sendo uma transação com I/O externo dentro. Uma alternativa seria um *lease* com transações curtas.
- **Latência das pendências** de até 60s depois que a referência chega.
- **Os relógios das instâncias definem os agendamentos** (`next_attempt_at`). Assumo relógios sincronizados (NTP).
- **O shutdown por sinal foi testado dentro do processo**, não enviando `SIGTERM` a um processo real, porque no Windows o sinal termina o processo à força. O que testo em processo real é a morte abrupta (`SIGKILL`) e o reinício.
- **LocalStack não é a AWS.** Encontrei uma diferença: ao devolver uma mensagem com visibilidade 0, o LocalStack destrava o grupo FIFO antes da hora. Escrevi o código para funcionar nos dois, mas não testei contra a AWS de verdade.
- **Métricas são por instância.** Quem agrega é o Prometheus.
- **A moeda efetivamente usada é BRL** nos testes, apesar de o modelo ser multi-moeda.

## 18. O que eu faria com mais tempo

- Autenticação com o desenho da seção 15.
- Enviar com `SendMessageBatch` os eventos de uma mesma wallet, para tirar o gargalo do publicador sem perder a ordem.
- Ordem por wallet também entre publicadores, com um *lease* por agregado.
- Trigger deferred para o invariante saldo × ledger.
- Contra-pressão e limite de taxa por provedor.
- OpenTelemetry e um painel de métricas.
- Rodar a suíte de concorrência contra SQS real da AWS.
