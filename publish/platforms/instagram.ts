import { publishConfig } from "../config";
import { log } from "../logger";
import type {
  PreparedMedia,
  PublishPayload,
  PublishResult,
  Publisher,
} from "../types";

// Instagram Graph API — публикация в профиль Business/Creator.
//
// Схема у Instagram двухшаговая (для видео — трёхшаговая):
//   1) создаём «контейнер» медиа — Instagram сам качает файл по ссылке;
//   2) для видео ждём, пока он его обработает (status_code=FINISHED);
//   3) публикуем контейнер (media_publish).
// Карусель: по контейнеру на каждый файл + родительский контейнер CAROUSEL.
//
// Требуется: аккаунт Instagram Business/Creator, связанный с Facebook-страницей,
// приложение Meta с разрешением instagram_content_publish и долгоживущий токен.
// Подробности и пошаговая настройка — в PUBLISH.md.

const cfg = () => publishConfig.instagram;

interface GraphError {
  message?: string;
  error_user_title?: string;
  error_user_msg?: string;
  code?: number;
  error_subcode?: number;
}

async function graph<T>(
  endpoint: string,
  params: Record<string, string>,
  method: "GET" | "POST" = "POST",
): Promise<T> {
  const { graphBase, apiVersion, accessToken } = cfg();
  const body = new URLSearchParams({ ...params, access_token: accessToken });
  const url =
    method === "GET"
      ? `${graphBase}/${apiVersion}/${endpoint}?${body}`
      : `${graphBase}/${apiVersion}/${endpoint}`;

  const res = await fetch(
    url,
    method === "GET" ? {} : { method: "POST", body },
  );
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `Instagram: неожиданный ответ (${res.status}): ${text.slice(0, 300)}`,
    );
  }

  const err = (json as { error?: GraphError }).error;
  if (err) {
    const detail = err.error_user_msg ?? err.message ?? "неизвестная ошибка";
    throw new Error(
      `Instagram: ${detail}${err.code ? ` (code ${err.code})` : ""}`,
    );
  }
  if (!res.ok)
    throw new Error(`Instagram: HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json as T;
}

/** Ждём, пока Instagram скачает и обработает видео. */
async function waitForContainer(containerId: string): Promise<void> {
  const deadline = Date.now() + cfg().videoTimeoutSec * 1000;
  let delayMs = 3000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delayMs));
    delayMs = Math.min(delayMs * 1.5, 15000);

    const info = await graph<{ status_code?: string; status?: string }>(
      containerId,
      { fields: "status_code,status" },
      "GET",
    );
    if (info.status_code === "FINISHED") return;
    if (info.status_code === "ERROR" || info.status_code === "EXPIRED") {
      throw new Error(
        `Instagram не смог обработать видео: ${info.status ?? info.status_code}`,
      );
    }
    log.info(
      `Instagram обрабатывает видео… (${info.status_code ?? "IN_PROGRESS"})`,
    );
  }
  throw new Error(
    `Instagram обрабатывает видео дольше ${cfg().videoTimeoutSec} с — попробуем в следующий раз`,
  );
}

/** Контейнер одного файла. Для карусели — is_carousel_item=true. */
async function createItemContainer(
  media: PreparedMedia,
  extra: Record<string, string>,
): Promise<string> {
  const params: Record<string, string> = { ...extra };
  if (media.kind === "video") params.video_url = media.url;
  else params.image_url = media.url;

  const { id } = await graph<{ id: string }>(`${cfg().userId}/media`, params);
  if (media.kind === "video") await waitForContainer(id);
  return id;
}

/** Осталась ли у аккаунта суточная квота на публикации (лимит Instagram — 50/сутки). */
async function quotaLeft(): Promise<number | null> {
  try {
    const res = await graph<{
      data?: { quota_usage?: number; config?: { quota_total?: number } }[];
    }>(
      `${cfg().userId}/content_publishing_limit`,
      { fields: "config,quota_usage" },
      "GET",
    );
    const row = res.data?.[0];
    if (!row) return null;
    const total = row.config?.quota_total ?? 50;
    return total - (row.quota_usage ?? 0);
  } catch {
    return null; // не смогли узнать — не повод отменять публикацию
  }
}

export const instagramPublisher: Publisher = {
  id: "instagram",
  label: "Instagram",
  needsPublicUrls: true,

  missingConfig() {
    const missing: string[] = [];
    if (!cfg().userId) missing.push("IG_USER_ID");
    if (!cfg().accessToken) missing.push("IG_ACCESS_TOKEN");
    return missing;
  },
  isConfigured() {
    return this.missingConfig().length === 0;
  },

  async publish({
    post,
    text,
    media,
    cover,
  }: PublishPayload): Promise<PublishResult> {
    const left = await quotaLeft();
    if (left !== null && left <= 0) {
      return {
        ok: false,
        error: "Instagram: исчерпан суточный лимит публикаций (50/сутки)",
      };
    }

    let creationId: string;

    if (post.type === "carousel") {
      // Контейнеры детей создаём последовательно: так понятнее, какой файл упал.
      const children: string[] = [];
      for (const item of media) {
        children.push(
          await createItemContainer(item, {
            is_carousel_item: "true",
            ...(item.kind === "video" ? { media_type: "VIDEO" } : {}),
          }),
        );
      }
      const parent = await graph<{ id: string }>(`${cfg().userId}/media`, {
        media_type: "CAROUSEL",
        children: children.join(","),
        caption: text,
      });
      creationId = parent.id;
    } else if (post.type === "reel") {
      creationId = await createItemContainer(media[0], {
        media_type: "REELS",
        caption: text,
        share_to_feed: cfg().shareReelsToFeed ? "true" : "false",
        ...(cover ? { cover_url: cover.url } : {}),
      });
    } else {
      creationId = await createItemContainer(media[0], { caption: text });
    }

    const published = await graph<{ id: string }>(
      `${cfg().userId}/media_publish`,
      {
        creation_id: creationId,
      },
    );

    // Ссылка на пост — приятно видеть в уведомлении, но не критично.
    let url: string | undefined;
    try {
      const info = await graph<{ permalink?: string }>(
        published.id,
        { fields: "permalink" },
        "GET",
      );
      url = info.permalink;
    } catch {
      /* permalink не обязателен */
    }

    return { ok: true, remoteId: published.id, url };
  },
};
