# Teste de carga

`bun run test:load` sobe processos reais da aplicação e gera tráfego HTTP concorrente. Esta página registra uma execução, como foi feita e o que eu concluo dela, inclusive o que ficou mal.

## Como o experimento funciona

- Sobe 3 instâncias da aplicação (`bun src/main.ts`), com os workers ligados, contra o Postgres e o LocalStack do `docker-compose.yml`.
- Cria 200 wallets com 100.000,00 BRL. 10% delas (20) são "quentes" e recebem 80% do tráfego; as outras 180 dividem o resto. Quis a disputa concentrada de propósito, porque é o pior caso para o lock por wallet.
- 64 usuários virtuais disparam requisições por 20 segundos, em round-robin entre as instâncias. A mistura é 70% `BET` de 1,00, 25% `WIN` de 1,50 e 5% `LOSS`. 5% das requisições são repetições exatas de uma anterior (mesma `Idempotency-Key`).
- Mede latência no cliente, status, conflitos de lock (métrica `lock_conflicts_total` de cada instância), lag da outbox (gauge `outbox_lag_seconds`, amostrada a cada segundo) e quanto tempo a outbox leva para esvaziar depois que a carga para.
- No fim confere duas coisas: não existe `idempotency_key` duplicada e todas as wallets têm saldo igual ao reconstruído pelo ledger.

Parâmetros ajustáveis por variável: `LOAD_INSTANCES`, `LOAD_WALLETS`, `LOAD_DURATION_S`, `LOAD_CONCURRENCY`, `LOAD_REPLAY_RATE`, `LOAD_HOT_SHARE`. O `OUTBOX_BATCH_SIZE` também vale, porque as instâncias herdam o ambiente.

## Ambiente

- Intel Core i5-10400F (12 threads), 15,9 GB de RAM, Windows 11
- Bun 1.4.4, Postgres 16 e LocalStack em containers (Docker Desktop, WSL2)
- **Gerador de carga, 3 instâncias da aplicação, Postgres e LocalStack na mesma máquina**, disputando CPU e disco. Os números abaixo servem para comparar mudanças nesta máquina, não para prever produção.

## Resultado (uma execução, 20 s)

| Item | Valor |
|---|---|
| Requisições | 8.531 |
| Throughput | **420,6 req/s** |
| Latência p50 / p95 / p99 | **90,4 / 353,2 / 419,9 ms** |
| Latência máxima | 768,7 ms |
| Status | 201: 8.113 · 200 (replay): 418 |
| Erros (5xx e rede) | **0** |
| 503 (transitórios) | 0 |
| Conflitos de lock (retries internos) | 0 |
| Replays de idempotência | 418 |
| Lag máximo da outbox durante a carga | **13,9 s** (11.869 eventos pendentes no pico) |
| Tempo para esvaziar a outbox depois da carga | **26,8 s** |
| Chaves de idempotência duplicadas | 0 |
| Wallets com saldo diferente do ledger | 0 |

Uma segunda execução, com `OUTBOX_BATCH_SIZE=250` em vez de 50, deu 409 req/s, p99 de 450 ms, lag máximo de 14,5 s e 25,9 s para esvaziar. A variação entre as duas execuções está dentro do ruído que eu esperaria de uma máquina compartilhada.

## O que eu concluo

**O que funcionou.** Com 80% do tráfego em 20 wallets e 64 clientes concorrentes, não houve nenhum erro, nenhuma chave duplicada e nenhuma wallet divergente do ledger. As 418 repetições foram respondidas como replay, sem efeito novo. Os 8.113 processamentos novos são exatamente os `201`.

**Conflitos de lock = 0.** Esse número precisa de cuidado na leitura. `lock_conflicts_total` conta só deadlocks, falhas de serialização e estouros de `lock_timeout` (2 s). Zero significa que ninguém esperou mais de 2 s, não que ninguém esperou. A espera normal pelo lock de uma wallet quente aparece na latência: o p99 de 420 ms é, em boa parte, fila atrás do lock. Não medi o tempo de espera do lock separadamente, então não sei quanto da latência é isso e quanto é custo de CPU e de I/O compartilhados.

**O que ficou mal: a outbox não acompanha.** O processamento sustenta ~420 transações por segundo, cada uma gerando em média 2 eventos (≈ 840 eventos/s), mas a outbox acumulou quase 12 mil eventos pendentes e levou ~27 s para esvaziar depois da carga. Ou seja, o publicador é mais lento que a produção de eventos. Os eventos não se perdem (a outbox é durável e esvaziou), mas o atraso de até 14 s entre o commit e a publicação seria visível para um consumidor.

Tentei aumentar o lote de 50 para 250 e **não mudou nada** (lag de 14,5 s contra 13,9 s). Então o tamanho do lote não é o limite. Minha hipótese, que **não verifiquei**: como mantenho a ordem dentro de cada wallet, os eventos de uma mesma wallet são enviados um de cada vez, e com 80% do tráfego em 20 wallets o envio dessas wallets quentes vira uma fila sequencial, com uma ida ao SQS por evento. Se for isso, o caminho é enviar os eventos de uma mesma wallet juntos com `SendMessageBatch` (o SQS FIFO preserva a ordem dentro do lote). Também pode haver parte de custo do LocalStack e da máquina compartilhada que eu não separei.

Esse é o custo direto da decisão de preservar a ordem por wallet dentro do publicador (ver `ARCHITECTURE.md`, seções 12 e 17). Em uma carga com tráfego mais espalhado entre wallets, esperaria um lag menor, mas não testei.

## O que este teste não mostra

- Não é um teste de capacidade: não procurei o ponto de saturação nem variei o número de instâncias.
- Uma execução por configuração, sem repetição estatística.
- Tudo na mesma máquina, com LocalStack no lugar do SQS real.
- A carga é só HTTP; o caminho do consumidor SQS tem testes de corretude, mas não de vazão.
- Não medi o custo da reconciliação nem das consultas de leitura.
