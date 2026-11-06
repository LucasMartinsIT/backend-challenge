import type { Request, Response } from 'express';

const VALID = /^[\w.:-]{1,128}$/;

/** Usa o x-correlation-id do chamador (se for razoável) ou gera um, e devolve no header. */
export function correlationIdOf(req: Request, res: Response): string {
  const incoming = req.header('x-correlation-id');
  const id = incoming && VALID.test(incoming) ? incoming : Bun.randomUUIDv7();
  res.setHeader('x-correlation-id', id);
  return id;
}
