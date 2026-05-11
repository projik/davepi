# syntax=docker/dockerfile:1.6

# ---- deps-prod ----
# Production dependencies only. Used for the runner image so it doesn't
# carry devDeps or build tooling.
FROM node:20-alpine AS deps-prod
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# ---- deps-dev ----
# All dependencies including devDeps (nodemon, jest, etc.). Used for the
# `dev` target so docker-compose can hot-reload source via nodemon.
FROM node:20-alpine AS deps-dev
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund

# ---- dev ----
# Used by docker-compose for local development. Mounts source from the
# host and runs nodemon so schema / route edits trigger a reload.
FROM node:20-alpine AS dev
WORKDIR /app
ENV NODE_ENV=development
COPY --from=deps-dev /app/node_modules ./node_modules
COPY . .
EXPOSE 4001
USER node
CMD ["npx", "nodemon", "--ignore", "swagger/*.json", "index.js"]

# ---- admin-build ----
# Build the admin SPA into admin/dist/ so the runner image serves it
# at /admin out of the box. Separate stage so the build's devDeps
# (vite, refine, etc.) don't bloat the production image.
FROM node:20-alpine AS admin-build
WORKDIR /app
COPY admin/package*.json ./admin/
RUN --mount=type=cache,target=/root/.npm \
    cd admin && npm ci --no-audit --no-fund
COPY admin ./admin
RUN cd admin && npm run build

# ---- runner ----
# Default target; the production image. Slim and non-root.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn
COPY --from=deps-prod /app/node_modules ./node_modules
COPY . .
# Overlay the freshly-built admin SPA on top of the source tree so
# /admin works in the production stack without a host-side
# `npm run build:admin` step.
COPY --from=admin-build /app/admin/dist ./admin/dist
EXPOSE 4001
USER node
CMD ["node", "index.js"]
