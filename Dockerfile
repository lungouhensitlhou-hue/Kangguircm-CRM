# One image, two roles: `web` (Next.js) and `worker` (agent runner). See docker-compose.yml.
FROM node:22-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS run
ENV NODE_ENV=production
COPY --from=build /app /app
EXPOSE 3000
# Default: migrate + web + worker in one container (free hosts). docker-compose overrides this per service.
CMD ["node", "scripts/start-all.mjs"]
