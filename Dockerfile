FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY ui ./ui
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps \
    AGENT_UI_HOST=0.0.0.0 \
    AGENT_UI_ENABLE_BASH=0 \
    AGENT_UI_WORKDIR=/workspace \
    AGENT_RUN_HISTORY_DIR=/data/history
WORKDIR /workspace
COPY --from=build --chown=node:node /app/dist /app/dist
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/package.json /app/package.json
RUN mkdir -p /workspace /data/history && chown -R node:node /workspace /data
USER node
EXPOSE 4173
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4173/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "/app/dist/ui/serve.js"]
