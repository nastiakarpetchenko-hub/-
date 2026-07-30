import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { pipeline as streamPipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { Bot, InputFile } from "grammy";
import { config } from "./config";
import { log } from "./logger";
import { processVideo, type Stage } from "./pipeline";

const bot = new Bot(config.botToken);

// Уникальный id задания без Date.now в горячем пути логики рендера.
let counter = 0;
const jobId = () => `${Date.now()}-${++counter}`;

const STAGE_TEXT: Record<Stage, string> = {
  downloaded: "📥 Видео получено…",
  transcribing: "🎧 Распознаю речь (русские субтитры)…",
  rendering: "🎬 Монтирую: субтитры + motion-дизайн…",
  done: "✅ Готово! Отправляю результат…",
  error: "⚠️ Ошибка при обработке. Попробуй ещё раз или пришли другой файл.",
};

bot.command("start", (ctx) =>
  ctx.reply(
    "Привет! 👋 Пришли мне видео — я наложу русские субтитры и motion-дизайн, " +
      "и верну готовый вертикальный ролик.\n\n" +
      `⚠️ Лимит Telegram Bot API на скачивание — 20 МБ. Для больших файлов ` +
      `нужен локальный Bot API сервер (подключим позже).`,
  ),
);

// Приём видео (как video или как document с видео-mime).
bot.on([":video", ":document"], async (ctx) => {
  const doc = ctx.message?.video ?? ctx.message?.document;
  if (!doc) return;
  const mime = "mime_type" in doc ? doc.mime_type ?? "" : "video/mp4";
  if (!mime.startsWith("video/")) {
    return ctx.reply("Это не похоже на видео 🤔 Пришли видеофайл.");
  }

  const status = await ctx.reply(STAGE_TEXT.downloaded);
  const id = jobId();
  const jobDir = path.join(config.workDir, "uploads", id);
  await fsp.mkdir(jobDir, { recursive: true });
  const videoPath = path.join(jobDir, "source.mp4");

  const setStage = async (s: Stage) => {
    try {
      await ctx.api.editMessageText(ctx.chat.id, status.message_id, STAGE_TEXT[s]);
    } catch {
      /* игнорируем "message is not modified" */
    }
  };

  try {
    // Скачиваем файл из Telegram на диск.
    const file = await ctx.getFile();
    const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    await streamPipeline(Readable.fromWeb(res.body), fs.createWriteStream(videoPath));
    log.ok(`Скачано: ${videoPath}`);

    // Прогоняем через пайплайн.
    const output = await processVideo(videoPath, jobDir, setStage);

    // Отправляем результат.
    await ctx.replyWithVideo(new InputFile(output), {
      caption: "Готово 🎬 Русские субтитры + motion-дизайн.",
    });
  } catch (e) {
    log.err(e);
    await setStage("error");
  } finally {
    // Убираем рабочую папку задания.
    await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
  }
});

bot.catch((err) => log.err("Bot error:", err.error));

async function main() {
  await fsp.mkdir(config.workDir, { recursive: true });
  log.info("Запускаю бота (long polling)…");
  await bot.start({
    onStart: (me) => log.ok(`Бот @${me.username} на связи`),
  });
}

main().catch((e) => {
  log.err(e);
  process.exit(1);
});
