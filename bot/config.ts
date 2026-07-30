import "dotenv/config";
import path from "node:path";

// Все настройки бота — через переменные окружения (.env локально,
// либо переменные в панели Railway/Render/Fly).

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Не задана переменная окружения ${name}. ` +
        `Добавь её в .env (локально) или в переменные площадки деплоя.`,
    );
  }
  return v;
}

export const config = {
  // Токен бота от @BotFather — единственный обязательный доступ.
  botToken: required("BOT_TOKEN"),

  // Рабочая папка для временных файлов (создаётся автоматически).
  workDir: path.resolve(process.env.WORK_DIR ?? "./.work"),

  // Движок субтитров: сейчас локальный whisper.cpp, позже "openai".
  subtitleEngine: (process.env.SUBTITLE_ENGINE ?? "whisper-cpp") as
    | "whisper-cpp"
    | "openai",

  whisper: {
    // Модель: "medium" — хороший баланс для русского; "large-v3-turbo" — точнее.
    model: process.env.WHISPER_MODEL ?? "medium",
    language: process.env.WHISPER_LANG ?? "ru",
    // Версия whisper.cpp (должна совпадать при установке и распознавании).
    version: process.env.WHISPER_CPP_VERSION ?? "1.7.4",
    // Куда whisper.cpp ставится (собирается из github — этот хост разрешён).
    installDir: path.resolve(process.env.WHISPER_DIR ?? "./.whisper"),
  },

  // Для будущего переключения на облачное распознавание.
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",

  // Ограничения обработки.
  maxDurationSec: Number(process.env.MAX_DURATION_SEC ?? "120"),
  maxFileSizeMb: Number(process.env.MAX_FILE_SIZE_MB ?? "50"),

  // Локальный статик-сервер, с которого Remotion читает загруженное видео.
  staticPort: Number(process.env.STATIC_PORT ?? "8787"),

  // Параллельность рендера Remotion (число вкладок).
  renderConcurrency: Number(process.env.RENDER_CONCURRENCY ?? "2"),

  // Визуал по умолчанию.
  accentColor: process.env.ACCENT_COLOR ?? "#FFD84D",
};

export type AppConfig = typeof config;
