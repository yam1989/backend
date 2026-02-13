# DM-2026 backend — Cloud Run stable
# Uses Node 20 (built-in fetch) and runs server.mjs
FROM node:20-slim

WORKDIR /app

# Install deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy app code
COPY server.mjs ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "server.mjs"]
