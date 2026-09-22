import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { publishConfig } from "./config";
import { isRemoteUrl, mediaKind, resolveMediaPath } from "./plan";
import { log } from "./logger";
import type { PreparedMedia } from "./types";

// Публичный доступ к медиа.
// Instagram не принимает файл напрямую: он скачивает его по ссылке, поэтому
// каждому локальному файлу нужен публичный http(s)-URL. ВКонтакте, наоборот,
// принимает сам файл — ему достаточно локального пути.

const MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".m4v": "video/x-m4v",
};

export function mimeOf(file: string): string {
  return (
    MIME[path.extname(file.split("?")[0]).toLowerCase()] ??
    "application/octet-stream"
  );
}

// ── Вариант «local»: раздаём файлы встроенным статик-сервером ─────────
// Работает, если у сервиса есть публичный домен (Render/Railway web-сервис).
// Ссылки непредсказуемые (случайный токен), чтобы папку нельзя было обойти.

const served = new Map<string, string>(); // токен → абсолютный путь
let localServer: http.Server | null = null;

function ensureLocalServer(): void {
  if (localServer) return;
  localServer = http.createServer((req, res) => {
    const token = decodeURIComponent((req.url ?? "").split("?")[0]).replace(
      /^\/m\//,
      "",
    );
    const file = served.get(token);
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    const size = fs.statSync(file).size;
    const type = mimeOf(file);
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Content-Length": size,
      "Accept-Ranges": "bytes",
    });
    fs.createReadStream(file).pipe(res);
  });
  localServer.listen(publishConfig.media.port, "0.0.0.0");
  log.ok(`Раздача медиа слушает порт ${publishConfig.media.port}`);
}

export function stopLocalServer(): void {
  localServer?.close();
  localServer = null;
}

function serveLocally(absPath: string): string {
  const base = publishConfig.media.publicBaseUrl;
  if (!base) {
    throw new Error(
      "Для Instagram нужен публичный адрес медиа. Задай PUBLIC_BASE_URL " +
        "(домен сервиса) либо переключись на MEDIA_HOST=s3 — см. PUBLISH.md.",
    );
  }
  ensureLocalServer();
  const token = `${crypto.randomBytes(12).toString("hex")}/${path.basename(absPath)}`;
  served.set(token, absPath);
  return `${base}/m/${token}`;
}

// ── Вариант «s3»: заливаем в S3-совместимое хранилище ────────────────
// Подходит Yandex Object Storage, Selectel, MinIO, AWS S3. Подписываем
// ссылку по SigV4 — бакет может оставаться закрытым.

const enc = (s: string) =>
  encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const encPath = (s: string) => s.split("/").map(enc).join("/");
const sha256 = (v: string) =>
  crypto.createHash("sha256").update(v).digest("hex");
const hmac = (key: crypto.BinaryLike | crypto.KeyObject, v: string) =>
  crypto
    .createHmac("sha256", key as crypto.BinaryLike)
    .update(v)
    .digest();

function presignS3(
  method: "PUT" | "GET",
  key: string,
  expiresSec: number,
): string {
  const s3 = publishConfig.media.s3;
  const missing = (
    ["endpoint", "bucket", "accessKeyId", "secretAccessKey"] as const
  ).filter((k) => !s3[k]);
  if (missing.length) {
    throw new Error(
      `MEDIA_HOST=s3, но не заданы: ${missing.map((m) => `S3_${m.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`).join(", ")}`,
    );
  }

  const endpoint = new URL(s3.endpoint);
  const host = endpoint.host;
  const canonicalUri = `/${encPath(s3.bucket)}/${encPath(key)}`;

  const now = new Date();
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${s3.region}/s3/aws4_request`;

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${s3.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresSec),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`)
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${s3.secretAccessKey}`, dateStamp), s3.region), "s3"),
    "aws4_request",
  );
  const signature = crypto
    .createHmac("sha256", signingKey)
    .update(stringToSign)
    .digest("hex");

  return `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

async function uploadToS3(absPath: string): Promise<string> {
  const s3 = publishConfig.media.s3;
  const key = `${s3.prefix}${crypto.randomBytes(6).toString("hex")}-${path.basename(absPath)}`;
  const body = await fs.promises.readFile(absPath);

  const putUrl = presignS3("PUT", key, 900);
  const res = await fetch(putUrl, {
    method: "PUT",
    body: new Uint8Array(body),
    headers: { "Content-Type": mimeOf(absPath) },
  });
  if (!res.ok) {
    throw new Error(
      `S3: загрузка не удалась (${res.status}) ${(await res.text()).slice(0, 300)}`,
    );
  }

  if (s3.publicBaseUrl) return `${s3.publicBaseUrl}/${encPath(key)}`;
  return presignS3("GET", key, s3.signedUrlTtlSec);
}

// ── Подготовка медиа для поста ────────────────────────────────────────

/**
 * Превращает запись из плана в готовый к отправке файл.
 * @param needsPublicUrl нужен ли публичный http-адрес (true — если есть Instagram)
 */
export async function prepareMedia(
  item: string,
  needsPublicUrl: boolean,
): Promise<PreparedMedia> {
  const kind = mediaKind(item);
  if (!kind) throw new Error(`не понимаю формат файла: ${item}`);

  if (isRemoteUrl(item)) {
    return { url: item, kind, mime: mimeOf(item) };
  }

  const absPath = resolveMediaPath(item);
  const stat = await fs.promises.stat(absPath);
  const base: PreparedMedia = {
    localPath: absPath,
    url: "",
    kind,
    mime: mimeOf(absPath),
    sizeBytes: stat.size,
  };

  if (!needsPublicUrl) return { ...base, url: `file://${absPath}` };

  switch (publishConfig.media.host) {
    case "s3":
      return { ...base, url: await uploadToS3(absPath) };
    case "none":
      throw new Error(
        `MEDIA_HOST=none, но файл «${item}» локальный, а Instagram скачивает медиа по ссылке. ` +
          `Укажи в плане http-ссылку или настрой MEDIA_HOST=local/s3.`,
      );
    default:
      return { ...base, url: serveLocally(absPath) };
  }
}
