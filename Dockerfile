FROM node:22-alpine
WORKDIR /app

# 容器預設是 UTC。todayBounds() 與 formatDate() 都吃 process 時區，
# 少了這行「今天的專注」在台灣早上 8 點前會全算到昨天。
ENV TZ=Asia/Taipei
RUN apk add --no-cache tzdata

COPY package*.json ./
# build 需要 typescript，所以裝完整依賴；編譯後再刪掉 devDependencies
RUN npm ci || npm install
COPY . .
RUN npm run build && npm prune --omit=dev
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/index.js"]
