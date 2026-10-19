# Build context is the repo root: docker build -f apps/web/Dockerfile .
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile --filter @paysim/web...
COPY . .
RUN pnpm --filter @paysim/web build

FROM nginx:stable-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
