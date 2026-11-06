import { Logger } from '@nestjs/common';

/**
 * Executa `task` em loop. Se a tarefa fez trabalho, roda de novo na hora (drena o backlog);
 * se não fez, dorme `intervalMs`. Erros são logados e o loop continua.
 */
export class PeriodicRunner {
  private readonly logger: Logger;
  private stopping = false;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly name: string,
    private readonly task: () => Promise<number>,
    private readonly intervalMs: number,
  ) {
    this.logger = new Logger(name);
  }

  start(): void {
    if (!this.loop) this.loop = this.run();
  }

  /** Espera a iteração em andamento terminar. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      let worked = 0;
      try {
        worked = await this.task();
      } catch (err) {
        this.logger.error(`iteração falhou: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!this.stopping && worked === 0) await this.sleep();
    }
  }

  private sleep() {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.intervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}
