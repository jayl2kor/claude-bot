FROM node:24-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build
# Prune dev dependencies for runtime
RUN npm ci --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl procps \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI (pinned version for reproducibility)
RUN npm install -g @anthropic-ai/claude-code@2.1.92

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

RUN mkdir -p /app/data /app/config && chown -R node:node /app/data /app/config

USER node

ENTRYPOINT ["node", "dist/main.js"]
