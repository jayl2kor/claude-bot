FROM node:24-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

FROM node:24-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl procps \
    && rm -rf /var/lib/apt/lists/*

# Install Claude CLI via npm (macOS binary won't work in Linux container)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# Create data directories writable by node user
RUN mkdir -p /app/data /app/config && chown -R node:node /app/data

USER node

ENTRYPOINT ["node", "dist/main.js"]
