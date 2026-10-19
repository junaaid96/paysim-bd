# Build context is the repo root: docker build -f apps/api/Dockerfile .
# One image: Express API + built React dashboard (served from WEB_DIST_DIR)
# + Drizzle migrations. Used by docker-compose, GHCR releases and Render.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /repo
# Full copy on purpose: the workspace graph (gateways, parity, examples)
# changes often, and a hand-maintained COPY list of package.jsons rots.
COPY . .
RUN pnpm install --frozen-lockfile
# API + dashboard + their workspace deps (core, all gateways). Docs and
# examples are intentionally not built into the runtime image.
RUN pnpm --filter @paysim/api... --filter @paysim/web... build
RUN pnpm --filter @paysim/api --prod deploy /app

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV WEB_DIST_DIR=/app/web-dist
WORKDIR /app
COPY --from=build /app ./
COPY --from=build /repo/apps/web/dist /app/web-dist
# Migrations live outside dist/ so the app can apply them on boot.
COPY --from=build /repo/apps/api/drizzle ./drizzle
RUN mkdir -p /data/blobs && chown node:node /data/blobs
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3001/api/health > /dev/null
CMD ["node", "dist/index.js"]
