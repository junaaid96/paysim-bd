# Build context is the repo root: docker build -f apps/web/Dockerfile .
# Standalone dashboard behind nginx (used by docker-compose on :8080).
# The API image also serves the dashboard; this one exists so local mode
# keeps working even if the API container is rebuilt without web assets.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /repo
# Full copy on purpose: see apps/api/Dockerfile.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @paysim/web... build

FROM nginx:stable-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
