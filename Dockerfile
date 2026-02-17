# DM-2026 Backend — minimal Dockerfile for FLUX image mode
FROM node:20-slim

WORKDIR /app

# Install only what we need
COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

ENV PORT=8080
EXPOSE 8080

CMD ["npm","start"]
