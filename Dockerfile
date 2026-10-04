FROM ghcr.io/foundry-rs/foundry:latest AS contracts

WORKDIR /app/packages/0-passkey
USER root

COPY packages/1-passkey ./

RUN forge build \
    --root . \
    --contracts server \
    --out server/out \
    --use 0.8.24 \
    --via-ir \
    --optimize \
    --no-cache

FROM node:26-alpine

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN npm install --global pnpm@12.5.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts biome.json ./
COPY packages ./packages

COPY --from=contracts \
  /app/packages/0-passkey/server/out \
  /app/packages/0-passkey/server/out

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

EXPOSE 8080 3000 3001
