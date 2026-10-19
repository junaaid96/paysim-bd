# Build context is the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @paysim/api...
COPY . .
RUN pnpm --filter @paysim/core build && pnpm --filter @paysim/api build
RUN pnpm --filter @paysim/api --prod deploy /app

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app ./
# Migrations live outside dist/ so the app can apply them on boot.
COPY --from=build /repo/apps/api/drizzle ./drizzle
RUN mkdir -p /data/blobs && chown node:node /data/blobs
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health > /dev/null
CMD ["node", "dist/index.js"]
