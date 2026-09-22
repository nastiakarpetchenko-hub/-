import fs from "node:fs";
import { pipeline as streamPipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Context } from "grammy";
import { config } from "./config";

// Скачивание файла из Telegram на диск.
// Лимит Bot API на скачивание — 20 МБ; для больших файлов нужен
// self-hosted Bot API сервер.

export async function downloadTelegramFile(
  ctx: Context,
  destPath: string,
): Promise<void> {
  const file = await ctx.getFile();
  const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok || !res.body)
    throw new Error(`не удалось скачать файл из Telegram (${res.status})`);
  await streamPipeline(
    Readable.fromWeb(res.body),
    fs.createWriteStream(destPath),
  );
}

/** Расширение файла по имени в Telegram (или запасное). */
export function extensionOf(
  name: string | undefined,
  fallback: string,
): string {
  const ext = name?.match(/\.([a-z0-9]{1,5})$/i)?.[1];
  return ext ? `.${ext.toLowerCase()}` : fallback;
}
