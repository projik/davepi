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

# ---- runner ----
# Default target; the production image. Slim and non-root.
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn
COPY --from=deps-prod /app/node_modules ./node_modules
COPY . .
EXPOSE 4001
USER node
CMD ["node", "index.js"]
