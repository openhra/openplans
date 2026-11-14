FROM node:22.23.5@sha256:e13726ca604184d7a91fcacab1fc09eefd642dc28e79ac34e85540dd93b78cfb AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY .github/npm-version .github/npm-version
COPY plugins ./plugins
RUN npm install --global "npm@$(cat .github/npm-version)" --no-audit --no-fund \
    && npm ci --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
# The plugin test kit in src/plugins/testing imports this helper at compile time.
COPY scripts/source-mutation.mjs scripts/source-mutation.d.mts ./scripts/
RUN npm run build && npm prune --omit=dev --no-audit --no-fund \
    && mkdir /runtime \
    && find plugins -mindepth 2 -maxdepth 2 \
      \( -name dist -o -name package.json -o -name migrations \) \
      -exec cp --parents -r {} /runtime/ \;

FROM node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /runtime/plugins ./plugins
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node data/rating-rules ./data/rating-rules
COPY --chown=node:node data/access ./data/access
# The worker's cache root: raw/, reports/ and work/ are bind mounts below it, and admitted
# collection keeps its per-host pacing leases in /data/access.
RUN install -d -o node -g node /data \
    && chmod +x dist/worker/cli.js dist/mcp/stdio.js \
    && ln -s /app/dist/worker/cli.js /usr/local/bin/worker \
    && ln -s /app/dist/mcp/stdio.js /usr/local/bin/openplans-mcp
USER node
EXPOSE 3000
CMD ["node", "dist/api/server.js"]
