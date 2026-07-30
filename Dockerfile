# Универсальный образ для деплоя бота на Railway / Render / Fly.
FROM node:22-bookworm-slim

# Системные библиотеки: Chromium (для Remotion) + сборка whisper.cpp.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git build-essential cmake \
    libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 \
    libxrandr2 libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 \
    libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Ставим зависимости (кэшируется, пока не менялся package-lock).
COPY package*.json ./
RUN npm ci

# Копируем исходники.
COPY . .

# whisper.cpp и модель докачаются при первом запуске (в тома .whisper).
# Chromium Remotion скачает автоматически при первом рендере.

ENV NODE_ENV=production

# Бот работает через long polling — входящий порт не требуется.
CMD ["npm", "run", "bot"]
