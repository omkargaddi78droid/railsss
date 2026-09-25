# syntax=docker/dockerfile:1
# Build context: repository root.

FROM node:24-alpine AS data
WORKDIR /app
COPY scripts/ scripts/
COPY backend/train_data/ backend/train_data/
ARG CLEAN_POLICY=correct
RUN cd scripts && node preprocess.ts --policy "$CLEAN_POLICY"

FROM node:24-alpine AS deps
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app/api
COPY --from=deps /app/api/node_modules ./node_modules
COPY api/package.json ./
COPY api/src ./src
# station master fallback + seed inputs
COPY --from=data /app/data/processed/stations.json /app/data/processed/trains.json /app/data/processed/
COPY --from=data /app/data/reports/quality-report.json /app/data/reports/
ENV API_PORT=4000 STATIONS_FILE=/app/data/processed/stations.json PROCESSED_DIR=/app/data/processed REPORTS_DIR=/app/data/reports
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:${API_PORT}/health > /dev/null || exit 1
CMD ["node", "src/server.ts"]
