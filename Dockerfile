# ── Stage 1: build ──────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY server.ts ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: produção ────────────────────────────────────────
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=384

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=builder --chown=node:node /app/dist ./dist

EXPOSE 8080

USER node

CMD ["node", "dist/server.js"]

