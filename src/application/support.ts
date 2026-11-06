export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export const systemClock: Clock = { now: () => new Date() };

// UUIDv7: ordenável por tempo, bom para índices
export const uuidV7Generator: IdGenerator = { next: () => Bun.randomUUIDv7() };
