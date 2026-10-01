FROM node:26-alpine

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN npm install --global pnpm@12.5.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts biome.json ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile
RUN pnpm -r build

EXPOSE 8080 3000 3001
