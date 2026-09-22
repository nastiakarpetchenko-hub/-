import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { publishConfig } from "./config";
import { isValidTimeZone, parsePlanTime } from "./tz";
import {
  PLATFORM_IDS,
  type PlannedPost,
  type PlatformId,
  type PostType,
} from "./types";

// Разбор и проверка контент-плана (content/plan.yaml).
// Задача модуля — поймать ошибки ДО публикации: опечатку в дате, пропавший
// файл, неизвестную площадку, слишком длинный текст.

const POST_TYPES: PostType[] = ["reel", "photo", "carousel"];

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v"]);

/** Ограничения площадок, которые дешевле проверить заранее. */
export const LIMITS = {
  instagramCaption: 2200,
  instagramHashtags: 30,
  vkMessage: 16000,
  carouselMin: 2,
  carouselMax: 10,
};

export interface PlanLoadResult {
  posts: PlannedPost[];
  timezone: string;
  /** Ошибки: такие посты в публикацию не попадают. */
  errors: string[];
  /** Предупреждения: публикуем, но стоит посмотреть. */
  warnings: string[];
}

export function isRemoteUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function mediaKind(value: string): "image" | "video" | null {
  const ext = path.extname(value.split("?")[0]).toLowerCase();
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  return null;
}

/** Абсолютный путь к медиафайлу из плана (пути — относительно content/). */
export function resolveMediaPath(value: string): string {
  const abs = path.resolve(publishConfig.contentDir, value);
  const root = publishConfig.contentDir + path.sep;
  if (!abs.startsWith(root)) {
    throw new Error(`путь «${value}» уводит за пределы папки content/`);
  }
  return abs;
}

/** Текст поста для конкретной площадки: переопределение + хештеги. */
export function textFor(post: PlannedPost, platform: PlatformId): string {
  const override = post.overrides[platform];
  const body = (override?.text ?? post.text).trim();
  const tags = override?.tags ?? post.tags;
  if (!tags.length) return body;
  const line = tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ");
  return body ? `${body}\n\n${line}` : line;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asStringList(value: unknown, field: string): string[] {
  return asArray(value).map((v) => {
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`поле «${field}» должно быть строкой или списком строк`);
    }
    return v.trim();
  });
}

interface RawPost {
  [key: string]: unknown;
}

function parsePost(
  raw: RawPost,
  index: number,
  defaults: RawPost,
  timezone: string,
  warnings: string[],
): PlannedPost {
  const pick = (key: string) => raw[key] ?? defaults[key];

  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  if (!id)
    throw new Error(`пост #${index + 1}: не задан «id» (уникальное имя поста)`);
  const where = `пост «${id}»`;

  const whenRaw = pick("when");
  if (typeof whenRaw !== "string" || !whenRaw.trim()) {
    throw new Error(
      `${where}: не задано время «when» (например «2026-09-23 10:00»)`,
    );
  }
  const when = parsePlanTime(whenRaw, timezone);

  const type = String(pick("type") ?? "").trim() as PostType;
  if (!POST_TYPES.includes(type)) {
    throw new Error(
      `${where}: неизвестный «type»: «${type || "—"}». Допустимо: ${POST_TYPES.join(", ")}`,
    );
  }

  const platforms = asStringList(
    pick("platforms"),
    "platforms",
  ) as PlatformId[];
  if (!platforms.length) throw new Error(`${where}: не заданы «platforms»`);
  for (const p of platforms) {
    if (!PLATFORM_IDS.includes(p)) {
      throw new Error(
        `${where}: неизвестная площадка «${p}». Допустимо: ${PLATFORM_IDS.join(", ")}`,
      );
    }
  }

  const media = asStringList(raw.media, "media");
  if (!media.length) throw new Error(`${where}: не заданы файлы «media»`);

  // Состав медиа под тип поста.
  if (type === "reel") {
    if (media.length !== 1)
      throw new Error(`${where}: для reel нужен ровно один видеофайл`);
    if (mediaKind(media[0]) !== "video") {
      throw new Error(
        `${where}: для reel нужен видеофайл (.mp4/.mov), указано «${media[0]}»`,
      );
    }
  }
  if (type === "photo") {
    if (media.length !== 1) {
      throw new Error(
        `${where}: для photo нужен один файл (для нескольких используй carousel)`,
      );
    }
    if (mediaKind(media[0]) !== "image") {
      throw new Error(
        `${where}: для photo нужна картинка (.jpg/.png), указано «${media[0]}»`,
      );
    }
  }
  if (type === "carousel") {
    if (
      media.length < LIMITS.carouselMin ||
      media.length > LIMITS.carouselMax
    ) {
      throw new Error(
        `${where}: в карусели должно быть от ${LIMITS.carouselMin} до ${LIMITS.carouselMax} файлов, сейчас ${media.length}`,
      );
    }
  }

  for (const item of media) {
    if (!mediaKind(item)) {
      throw new Error(
        `${where}: не понимаю формат файла «${item}» (ожидаю jpg/png/mp4/mov)`,
      );
    }
    if (!isRemoteUrl(item)) {
      const abs = resolveMediaPath(item);
      if (!fs.existsSync(abs))
        throw new Error(`${where}: файл не найден — ${item}`);
    }
    if (
      platforms.includes("instagram") &&
      mediaKind(item) === "image" &&
      !/\.jpe?g$/i.test(item.split("?")[0])
    ) {
      warnings.push(
        `${where}: Instagram надёжно принимает только JPEG — «${item}» лучше пересохранить в .jpg`,
      );
    }
  }

  const cover = raw.cover === undefined ? undefined : String(raw.cover).trim();
  if (cover) {
    if (mediaKind(cover) !== "image")
      throw new Error(`${where}: «cover» должен быть картинкой`);
    if (!isRemoteUrl(cover) && !fs.existsSync(resolveMediaPath(cover))) {
      throw new Error(`${where}: обложка не найдена — ${cover}`);
    }
  }

  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  const tags = asStringList(pick("tags"), "tags");

  const overrides: PlannedPost["overrides"] = {};
  const rawOverrides = (raw.overrides ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(rawOverrides)) {
    if (!PLATFORM_IDS.includes(key as PlatformId)) {
      throw new Error(`${where}: в «overrides» неизвестная площадка «${key}»`);
    }
    const o = (value ?? {}) as Record<string, unknown>;
    overrides[key as PlatformId] = {
      text: typeof o.text === "string" ? o.text.trim() : undefined,
      tags:
        o.tags === undefined
          ? undefined
          : asStringList(o.tags, "overrides.tags"),
    };
  }

  const post: PlannedPost = {
    id,
    whenRaw,
    when,
    platforms,
    type,
    media,
    cover,
    text,
    tags,
    overrides,
  };

  // Лимиты текста — предупреждаем заранее, площадка иначе откажет при отправке.
  if (platforms.includes("instagram")) {
    const igText = textFor(post, "instagram");
    if (igText.length > LIMITS.instagramCaption) {
      throw new Error(
        `${where}: подпись для Instagram — ${igText.length} символов, лимит ${LIMITS.instagramCaption}`,
      );
    }
    const hashtags = (igText.match(/#/g) ?? []).length;
    if (hashtags > LIMITS.instagramHashtags) {
      throw new Error(
        `${where}: в Instagram максимум ${LIMITS.instagramHashtags} хештегов, сейчас ${hashtags}`,
      );
    }
  }
  if (
    platforms.includes("vk") &&
    textFor(post, "vk").length > LIMITS.vkMessage
  ) {
    throw new Error(
      `${where}: текст для ВК длиннее ${LIMITS.vkMessage} символов`,
    );
  }

  return post;
}

/** Читает и проверяет контент-план. Битые посты не роняют весь план. */
export function loadPlan(file = publishConfig.planFile): PlanLoadResult {
  if (!fs.existsSync(file)) {
    throw new Error(
      `Контент-план не найден: ${file}\n` +
        `Скопируй пример: cp content/plan.example.yaml content/plan.yaml`,
    );
  }

  let doc: unknown;
  try {
    doc = YAML.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(
      `Не удалось разобрать YAML (${file}): ${(e as Error).message}`,
    );
  }

  const errors: string[] = [];
  const warnings: string[] = [];

  let rawPosts: RawPost[] = [];
  let defaults: RawPost = {};
  let timezone = publishConfig.timezone;

  if (Array.isArray(doc)) {
    rawPosts = doc as RawPost[];
  } else if (doc && typeof doc === "object") {
    const obj = doc as Record<string, unknown>;
    if (typeof obj.timezone === "string" && obj.timezone.trim())
      timezone = obj.timezone.trim();
    defaults = (obj.defaults ?? {}) as RawPost;
    rawPosts = asArray(obj.posts) as RawPost[];
  } else if (doc === null) {
    rawPosts = []; // пустой файл — это нормально
  } else {
    throw new Error("Ожидаю список постов или объект с полем «posts».");
  }

  if (!isValidTimeZone(timezone)) {
    throw new Error(`Неизвестный часовой пояс: «${timezone}»`);
  }

  const posts: PlannedPost[] = [];
  const seen = new Set<string>();

  rawPosts.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      errors.push(`пост #${index + 1}: ожидаю объект с полями id/when/type/…`);
      return;
    }
    try {
      const post = parsePost(raw, index, defaults, timezone, warnings);
      if (seen.has(post.id)) {
        errors.push(
          `пост «${post.id}»: такой id уже есть — id должны быть уникальными`,
        );
        return;
      }
      seen.add(post.id);
      posts.push(post);
    } catch (e) {
      errors.push((e as Error).message);
    }
  });

  posts.sort((a, b) => a.when.getTime() - b.when.getTime());
  return { posts, timezone, errors, warnings };
}
