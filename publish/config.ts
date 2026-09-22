import "dotenv/config";
import path from "node:path";

// Настройки автопубликации. Всё — через переменные окружения,
// чтобы токены не лежали в репозитории (см. .env.example и PUBLISH.md).

const str = (name: string, fallback = "") =>
  process.env[name]?.trim() || fallback;
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : fallback;
};
const bool = (name: string, fallback = false) => {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return v === "1" || v === "true" || v === "yes" || v === "да";
};

const contentDir = path.resolve(str("CONTENT_DIR", "./content"));

export const publishConfig = {
  /** Папка с контент-планом и медиафайлами. */
  contentDir,
  planFile: path.resolve(str("PLAN_FILE", path.join(contentDir, "plan.yaml"))),
  stateFile: path.resolve(
    str("STATE_FILE", path.join(contentDir, ".state.json")),
  ),

  /** Часовой пояс, в котором записано время в контент-плане. */
  timezone: str("TIMEZONE", "Europe/Moscow"),

  /** Как часто планировщик проверяет план (сек). */
  intervalSec: num("SCHEDULER_INTERVAL_SEC", 60),
  /** Насколько «просроченный» пост ещё можно опубликовать (мин).
   *  Нужно, чтобы после простоя сервера не выкатился весь архив разом. */
  graceMinutes: num("PUBLISH_GRACE_MIN", 180),
  /** Сколько раз пробовать при ошибке сети/площадки. */
  maxAttempts: num("PUBLISH_MAX_ATTEMPTS", 3),

  /** Ничего не публиковать, только показать, что было бы отправлено. */
  dryRun: bool("PUBLISH_DRY_RUN", false),

  // ── Публичный доступ к медиа (нужен Instagram: он скачивает файл сам) ──
  media: {
    /** local — отдаём файлы встроенным статик-сервером по PUBLIC_BASE_URL;
     *  s3 — заливаем в S3-совместимое хранилище (Yandex/Selectel/MinIO/AWS);
     *  none — в плане уже указаны готовые http-ссылки. */
    host: str("MEDIA_HOST", "local") as "local" | "s3" | "none",
    publicBaseUrl: str("PUBLIC_BASE_URL").replace(/\/+$/, ""),
    port: num("MEDIA_PORT", 8788),
    s3: {
      endpoint: str("S3_ENDPOINT"), // напр. https://storage.yandexcloud.net
      region: str("S3_REGION", "ru-central1"),
      bucket: str("S3_BUCKET"),
      accessKeyId: str("S3_ACCESS_KEY_ID"),
      secretAccessKey: str("S3_SECRET_ACCESS_KEY"),
      prefix: str("S3_PREFIX", "publish/"),
      /** Если бакет публичный — свой базовый URL; иначе делаем подписанную ссылку. */
      publicBaseUrl: str("S3_PUBLIC_BASE_URL").replace(/\/+$/, ""),
      signedUrlTtlSec: num("S3_SIGNED_URL_TTL_SEC", 3600),
    },
  },

  // ── Instagram (Graph API, аккаунт Business/Creator + Meta-приложение) ──
  instagram: {
    userId: str("IG_USER_ID"),
    accessToken: str("IG_ACCESS_TOKEN"),
    apiVersion: str("IG_API_VERSION", "v21.0"),
    graphBase: str("IG_GRAPH_BASE", "https://graph.facebook.com"),
    /** Публиковать reel и в основную ленту профиля. */
    shareReelsToFeed: bool("IG_SHARE_REELS_TO_FEED", true),
    /** Сколько ждать обработки видео на стороне Instagram (сек). */
    videoTimeoutSec: num("IG_VIDEO_TIMEOUT_SEC", 300),
  },

  // ── ВКонтакте (ключ доступа сообщества, права wall/photos/video) ──
  vk: {
    /** Числовой id сообщества (без минуса). */
    groupId: str("VK_GROUP_ID"),
    accessToken: str("VK_ACCESS_TOKEN"),
    apiVersion: str("VK_API_VERSION", "5.199"),
    apiBase: str("VK_API_BASE", "https://api.vk.com/method"),
    /** Публиковать от имени сообщества, а не от своего профиля. */
    fromGroup: bool("VK_FROM_GROUP", true),
    /** Вертикальные видео до 3 минут заливать как Клип. */
    clipsForReels: bool("VK_CLIPS_FOR_REELS", false),
  },

  // ── Уведомления о результате (в Telegram, тем же ботом) ──
  notify: {
    botToken: str("BOT_TOKEN"),
    chatId: str("NOTIFY_CHAT_ID"),
    /** Сообщать и об успешных публикациях, не только об ошибках. */
    onSuccess: bool("NOTIFY_ON_SUCCESS", true),
  },
};

export type PublishConfig = typeof publishConfig;
