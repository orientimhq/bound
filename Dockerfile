# syntax=docker/dockerfile:1
# Orientim on one Fly machine (fly.toml). The same build as CI and release.yml: npm ci without install
# scripts, then `next build` with the public settings compiled in, so its digest can be compared.

FROM node:24-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
COPY packages/builder/package.json packages/builder/
COPY packages/certificate/package.json packages/certificate/
COPY packages/jupiter/package.json packages/jupiter/
RUN npm ci --ignore-scripts
COPY . .
# Compiled into the page: changing one needs a new build (apps/web/.env.example).
ARG ORIENTIM_BUILD_ID
ARG NEXT_PUBLIC_ORIENTIM_TREASURY
ARG NEXT_PUBLIC_ORIENTIM_FEE_BPS=25
ARG NEXT_PUBLIC_ORIENTIM_ENABLE_V1=
# The lower fee for large swaps (docs/FLY.md): off while empty.
ARG NEXT_PUBLIC_ORIENTIM_FEE_TIER_BPS=
ARG NEXT_PUBLIC_ORIENTIM_FEE_TIER_SOL=
RUN test -n "$ORIENTIM_BUILD_ID" || { echo 'ORIENTIM_BUILD_ID is required: fly deploy --build-arg ORIENTIM_BUILD_ID=$(git rev-parse HEAD)'; exit 1; }
RUN test -n "$NEXT_PUBLIC_ORIENTIM_TREASURY" || { echo 'NEXT_PUBLIC_ORIENTIM_TREASURY is required ([build.args] in fly.toml).'; exit 1; }
RUN npm run build && node tools/build-digest.ts --write

FROM node:24-bookworm-slim
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=8080
ARG ORIENTIM_BUILD_ID
ENV ORIENTIM_BUILD_ID=$ORIENTIM_BUILD_ID
COPY --from=build --chown=node:node /app /app
COPY --chmod=755 tools/fly-start.sh /usr/local/bin/orientim-start
WORKDIR /app/apps/web
EXPOSE 8080
CMD ["orientim-start"]
