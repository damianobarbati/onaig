FROM node:26-alpine

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN npm install --global pnpm@12.5.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json vitest.config.ts biome.json ./
COPY packages ./packages

RUN pnpm install --frozen-lockfile \
  && pnpm -F passkey app:build

EXPOSE 80 8080

CMD ["pnpm", "-F", "passkey", "app:preview", "--host", "0.0.0.0", "--port", "80"]
