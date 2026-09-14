# gods-eye-compat: the Gods Eye provider server without Vite (DWM-34).
# Transitional. Deleted when both ledgers in
# server/standalone/compat-providers.js are empty.
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8200
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY src ./src
COPY scripts ./scripts
COPY config ./config
RUN mkdir -p .gev-cache .gev-logs && chown node:node .gev-cache .gev-logs
USER node
EXPOSE 8200
CMD ["node", "server/standalone/provider-server.mjs"]
