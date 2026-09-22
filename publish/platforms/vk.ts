import fs from "node:fs";
import path from "node:path";
import { publishConfig } from "../config";
import { log } from "../logger";
import type {
  PreparedMedia,
  PublishPayload,
  PublishResult,
  Publisher,
} from "../types";

// ВКонтакте — публикация на стену сообщества.
//
// В отличие от Instagram, ВК принимает сам файл:
//   1) просим у API адрес для загрузки (photos.getWallUploadServer / video.save);
//   2) шлём файл multipart-ом на этот адрес;
//   3) сохраняем и получаем идентификатор вложения (photo123_456 / video…);
//   4) публикуем запись wall.post со всеми вложениями сразу.
//
// Требуется ключ доступа сообщества с правами wall, photos, video
// (получение ключа — в PUBLISH.md).

const cfg = () => publishConfig.vk;

interface VkError {
  error_code: number;
  error_msg: string;
}

async function api<T>(
  method: string,
  params: Record<string, string | number>,
): Promise<T> {
  const body = new URLSearchParams({
    ...Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)]),
    ),
    access_token: cfg().accessToken,
    v: cfg().apiVersion,
  });
  const res = await fetch(`${cfg().apiBase}/${method}`, {
    method: "POST",
    body,
  });
  const text = await res.text();

  let json: { response?: T; error?: VkError };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `ВКонтакте: неожиданный ответ ${method} (${res.status}): ${text.slice(0, 300)}`,
    );
  }
  if (json.error) {
    throw new Error(
      `ВКонтакте: ${json.error.error_msg} (код ${json.error.error_code}, ${method})`,
    );
  }
  if (json.response === undefined)
    throw new Error(`ВКонтакте: пустой ответ ${method}`);
  return json.response;
}

/** Отправка файла на выданный ВК upload_url. */
async function uploadFile(
  uploadUrl: string,
  fieldName: string,
  media: PreparedMedia,
): Promise<Record<string, unknown>> {
  const buffer = media.localPath
    ? await fs.promises.readFile(media.localPath)
    : Buffer.from(await (await fetch(media.url)).arrayBuffer());
  const filename = media.localPath
    ? path.basename(media.localPath)
    : `upload.${media.kind === "video" ? "mp4" : "jpg"}`;

  const form = new FormData();
  form.append(
    fieldName,
    new Blob([new Uint8Array(buffer)], { type: media.mime }),
    filename,
  );

  const res = await fetch(uploadUrl, { method: "POST", body: form });
  const text = await res.text();
  if (!res.ok)
    throw new Error(
      `ВКонтакте: загрузка файла не удалась (${res.status}): ${text.slice(0, 200)}`,
    );
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(
      `ВКонтакте: непонятный ответ загрузчика: ${text.slice(0, 200)}`,
    );
  }
}

/** Фото → вложение вида photo-123_456. */
async function uploadPhoto(media: PreparedMedia): Promise<string> {
  const groupId = cfg().groupId;
  const server = await api<{ upload_url: string }>(
    "photos.getWallUploadServer",
    {
      group_id: groupId,
    },
  );

  // Имя поля именно file0 — так его ждёт загрузчик фото на стену.
  const uploaded = await uploadFile(server.upload_url, "file0", media);

  const saved = await api<{ owner_id: number; id: number }[]>(
    "photos.saveWallPhoto",
    {
      group_id: groupId,
      server: String(uploaded.server ?? ""),
      photo: String(uploaded.photo ?? uploaded.photos_list ?? ""),
      hash: String(uploaded.hash ?? ""),
    },
  );
  const photo = saved[0];
  if (!photo) throw new Error("ВКонтакте: фото загрузилось, но не сохранилось");
  return `photo${photo.owner_id}_${photo.id}`;
}

/** Видео → вложение вида video-123_456. */
async function uploadVideo(
  media: PreparedMedia,
  name: string,
  description: string,
): Promise<string> {
  const saved = await api<{
    upload_url: string;
    owner_id: number;
    video_id: number;
  }>("video.save", {
    group_id: cfg().groupId,
    name: name.slice(0, 128),
    description: description.slice(0, 5000),
    wallpost: 0, // запись на стену делаем сами — одной общей публикацией
  });

  await uploadFile(saved.upload_url, "video_file", media);
  return `video${saved.owner_id}_${saved.video_id}`;
}

/**
 * Попытка залить вертикальный ролик как Клип.
 * ВК не документирует shortVideo.create публично и открывает его не всем
 * приложениям, поэтому при любой ошибке молча откатываемся на обычное видео.
 */
async function tryUploadClip(
  media: PreparedMedia,
  description: string,
): Promise<string | null> {
  try {
    const created = await api<{
      upload_url: string;
      owner_id: number;
      video_id: number;
    }>("shortVideo.create", {
      group_id: cfg().groupId,
      description: description.slice(0, 5000),
    });
    await uploadFile(created.upload_url, "file", media);
    log.ok("ВКонтакте: ролик загружен как Клип");
    return `video${created.owner_id}_${created.video_id}`;
  } catch (e) {
    log.warn(
      `ВКонтакте: Клип не получился (${(e as Error).message}) — гружу обычным видео`,
    );
    return null;
  }
}

export const vkPublisher: Publisher = {
  id: "vk",
  label: "ВКонтакте",
  needsPublicUrls: false,

  missingConfig() {
    const missing: string[] = [];
    if (!cfg().groupId) missing.push("VK_GROUP_ID");
    if (!cfg().accessToken) missing.push("VK_ACCESS_TOKEN");
    return missing;
  },
  isConfigured() {
    return this.missingConfig().length === 0;
  },

  async publish({ post, text, media }: PublishPayload): Promise<PublishResult> {
    const title = (text.split("\n").find((l) => l.trim()) ?? post.id).slice(
      0,
      128,
    );
    const attachments: string[] = [];

    for (const item of media) {
      if (item.kind === "image") {
        attachments.push(await uploadPhoto(item));
        continue;
      }
      const clip =
        post.type === "reel" && cfg().clipsForReels
          ? await tryUploadClip(item, text)
          : null;
      attachments.push(clip ?? (await uploadVideo(item, title, text)));
    }

    const ownerId = `-${cfg().groupId}`;
    const posted = await api<{ post_id: number }>("wall.post", {
      owner_id: ownerId,
      from_group: cfg().fromGroup ? 1 : 0,
      message: text,
      attachments: attachments.join(","),
    });

    return {
      ok: true,
      remoteId: `${ownerId}_${posted.post_id}`,
      url: `https://vk.com/wall${ownerId}_${posted.post_id}`,
    };
  },
};
