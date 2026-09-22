// Общие типы системы автопубликации.

/** Площадки, на которые умеем публиковать. */
export type PlatformId = "instagram" | "vk";

export const PLATFORM_IDS: PlatformId[] = ["instagram", "vk"];

/** Тип поста. Один и тот же контент раскладывается по площадкам по-разному. */
export type PostType = "reel" | "photo" | "carousel";

/** Пост, каким его написал человек в контент-плане (после валидации). */
export interface PlannedPost {
  /** Уникальный id поста — ключ идемпотентности, менять нельзя. */
  id: string;
  /** Время публикации по локальному часовому поясу (как в плане). */
  whenRaw: string;
  /** То же время, переведённое в UTC. */
  when: Date;
  /** Куда публикуем. */
  platforms: PlatformId[];
  type: PostType;
  /** Пути к файлам относительно content/ либо готовые http(s)-ссылки. */
  media: string[];
  /** Обложка для reel (необязательно). */
  cover?: string;
  /** Текст поста (общий для всех площадок, если нет переопределения). */
  text: string;
  /** Хештеги без «#» — добавляются к тексту. */
  tags: string[];
  /** Переопределения текста/хештегов под конкретную площадку. */
  overrides: Partial<Record<PlatformId, { text?: string; tags?: string[] }>>;
}

/** Медиафайл, подготовленный к отправке: локальный путь + публичная ссылка. */
export interface PreparedMedia {
  /** Абсолютный путь к локальному файлу (нет — если в плане был http-URL). */
  localPath?: string;
  /** Публичная ссылка: обязательна для Instagram, он скачивает файл сам. */
  url: string;
  kind: "image" | "video";
  mime: string;
  sizeBytes?: number;
}

/** Всё, что нужно паблишеру для одного поста. */
export interface PublishPayload {
  post: PlannedPost;
  /** Текст с уже подставленными хештегами под конкретную площадку. */
  text: string;
  media: PreparedMedia[];
  cover?: PreparedMedia;
}

export interface PublishResult {
  ok: boolean;
  /** Ссылка на опубликованный пост, если площадка её вернула. */
  url?: string;
  /** Идентификатор поста на площадке. */
  remoteId?: string;
  error?: string;
}

/** Адаптер площадки. Новая площадка = ещё один такой объект. */
export interface Publisher {
  id: PlatformId;
  label: string;
  /** Заданы ли токены/доступы в переменных окружения. */
  isConfigured(): boolean;
  /** Чего не хватает в настройках (для понятной ошибки). */
  missingConfig(): string[];
  /** Нужны ли публичные http-ссылки на медиа (Instagram — да, ВК — нет). */
  needsPublicUrls: boolean;
  publish(payload: PublishPayload): Promise<PublishResult>;
}
