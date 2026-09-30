FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
# Reproducible install from the lockfile (ws is the only runtime dependency).
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
RUN mkdir -p /data
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/index.js"]
