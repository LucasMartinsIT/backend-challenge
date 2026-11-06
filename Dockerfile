FROM oven/bun:1

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# o tsconfig é lido em tempo de execução (decorators do Nest e metadados de tipos)
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 3000

USER bun
CMD ["bun", "src/main.ts"]
