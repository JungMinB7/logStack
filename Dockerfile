# ── build stage ─────────────────────────────────────────────
FROM node:24-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ───────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

EXPOSE 3000

# 부팅 시 마이그레이션 적용 후 서버 시작 (docker compose up 만으로 실행 가능)
# 마이그레이션은 컴파일된 DataSource(dist)로 실행한다 — 런타임에 ts-node 불필요
CMD ["sh", "-c", "npx typeorm migration:run -d dist/database/data-source.js && node dist/main.js"]
