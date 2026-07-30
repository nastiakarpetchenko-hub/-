# Telegram-бот: авто-субтитры + motion-дизайн

Пришли боту видео → он распознаёт речь, накладывает **русские субтитры**
(TikTok-стиль с подсветкой слов) и **motion-дизайн** (плашки, прогресс-бар,
поп-ап анимации), и возвращает готовый вертикальный ролик 9:16.

## Как это устроено

```
Telegram ──видео──▶ bot/index.ts (grammY, long polling)
                        │  скачивает файл
                        ▼
                 bot/transcribe.ts ── Whisper (ru) → субтитры со словными таймингами
                        │
                        ▼
                 bot/render.ts ── Remotion (composition "AutoCaptioned") → mp4
                        │
                        ▼
                 отправка результата обратно в чат
```

| Файл | Назначение |
|---|---|
| `bot/index.ts` | сам бот: приём видео, прогресс, отправка результата |
| `bot/pipeline.ts` | оркестратор: распознать → отрендерить |
| `bot/transcribe.ts` | Whisper (локально `whisper.cpp`, задел под OpenAI API) |
| `bot/render.ts` | программный рендер Remotion + локальный статик-сервер |
| `bot/config.ts` | все настройки через переменные окружения |
| `src/video/AutoCaptioned.tsx` | Remotion-композиция: видео + субтитры + motion |

## Шаг 1. Получить токен бота

1. В Telegram напиши **@BotFather** → `/newbot`.
2. Задай имя и username бота.
3. Скопируй токен вида `123456:ABC-DEF...`.

## Шаг 2. Локальный запуск (для теста)

```bash
cp .env.example .env
# впиши BOT_TOKEN=... в .env
npm install
npm run bot
```

Первый запуск скачает `whisper.cpp` и модель (для `medium` ~1.5 ГБ) —
это происходит один раз. Дальше отправь боту видео в Telegram.

> ⚠️ **Лимит Telegram Bot API:** скачивание файла — до **20 МБ**. Для
> больших видео нужен self-hosted Bot API server (подключим отдельно).

## Шаг 3. Деплой на PaaS (бот онлайн 24/7)

Во всех вариантах задай переменную окружения **`BOT_TOKEN`** (секрет).
Остальные — из `.env.example`, можно оставить дефолтными.

### Railway
1. New Project → Deploy from GitHub → выбери репозиторий и ветку.
2. Railway сам увидит `Dockerfile`.
3. Variables → добавь `BOT_TOKEN`.
4. Добавь Volume, смонтируй на `/app/.whisper` (чтобы модель не качалась заново).

### Render
1. New → Blueprint → подключи репозиторий (прочитает `render.yaml`).
2. Впиши `BOT_TOKEN` в секреты.
3. Deploy. Диск для модели уже описан в `render.yaml`.

### Fly.io
```bash
flyctl launch --no-deploy   # прочитает fly.toml
flyctl secrets set BOT_TOKEN=123456:ABC-DEF...
flyctl volumes create botdata --size 5
flyctl deploy
```

## Настройки (переменные окружения)

Все — в `.env.example`. Главное:

| Переменная | Смысл | Дефолт |
|---|---|---|
| `BOT_TOKEN` | токен от @BotFather (**обязателен**) | — |
| `SUBTITLE_ENGINE` | `whisper-cpp` (локально) или `openai` | `whisper-cpp` |
| `WHISPER_MODEL` | `small` / `medium` / `large-v3-turbo` | `medium` |
| `WHISPER_LANG` | язык распознавания | `ru` |
| `OPENAI_API_KEY` | ключ, если `SUBTITLE_ENGINE=openai` | — |
| `MAX_DURATION_SEC` | ограничение длины ролика | `120` |
| `ACCENT_COLOR` | акцентный цвет субтитров/плашек | `#FFD84D` |

## Переключение на облачные субтитры (позже)

Когда захочешь максимальную точность без нагрузки на сервер:
```
SUBTITLE_ENGINE=openai
OPENAI_API_KEY=sk-...
```
Код уже готов — `bot/transcribe.ts` содержит обе ветки.

## Точность / «весёлость» субтитров

- Русский: `medium` даёт хорошее качество, `large-v3-turbo` — заметно точнее
  (тяжелее). Меняется одной переменной `WHISPER_MODEL`.
- Стиль (цвета, шрифт, анимации плашек) правится в `src/video/AutoCaptioned.tsx`
  и `src/video/theme.ts` — обсудим дизайн и подгоним под тебя.
