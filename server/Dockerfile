# Publium backend — build TypeScript separately and run the API as an unprivileged user.
FROM node:20-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY scripts/clean-dist.mjs ./scripts/clean-dist.mjs
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY prisma ./prisma
RUN npx prisma generate \
 && npx playwright install --with-deps chromium

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node assets ./assets
COPY --chown=node:node scripts ./scripts
RUN mkdir -p /data/uploads \
 && chown node:node /app /data/uploads

# Dependencies and browser binaries are read-only at runtime. Recursively chowning
# them here duplicated ~1.5 GB into a new layer on every source-code release.
# Application files above already use COPY --chown; only writable roots need ownership.

USER node
EXPOSE 8787
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
