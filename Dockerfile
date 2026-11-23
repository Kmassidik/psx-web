FROM oven/bun:1.4.4 AS base
WORKDIR /app/apps
COPY apps/package.json apps/bun.lock ./
RUN bun install --frozen-lockfile

FROM base AS test
COPY apps/tsconfig.json ./
COPY apps/src ./src
COPY apps/tests ./tests
COPY assets/nortis /app/assets/nortis
RUN bun run typecheck && bun test

FROM base AS runtime
COPY apps/src ./src
EXPOSE 5173
CMD ["bun", "run", "dev"]
