import path from "node:path";
import fsp from "node:fs/promises";
import { InlineKeyboard, InputFile, type Bot } from "grammy";
import { config } from "./config";
import { log } from "./logger";
import { processVideo, type Stage } from "./pipeline";
import { downloadTelegramFile } from "./download";
import { adoptLocalFile, startVideoDraft } from "./publishing";

// Приём видео: сначала спрашиваем, что с ним делать — смонтировать
// (субтитры + motion-дизайн) или сразу поставить в план публикаций.
// Смонтированный ролик тоже можно отправить в план одной кнопкой.

const STAGE_TEXT: Record<Stage, string> = {
  downloaded: "📥 Видео получено…",
  transcribing: "🎧 Распознаю речь (русские субтитры)…",
  rendering: "🎬 Монтирую: субтитры + motion-дизайн…",
  done: "✅ Готово! Отправляю результат…",
  error: "⚠️ Ошибка при обработке. Попробуй ещё раз или пришли другой файл.",
};

interface VideoJob {
  dir: string;
  source: string;
  /** Смонтированный результат, если монтаж уже прошёл. */
  result?: string;
  caption: string;
  createdAt: number;
}

const videoJobs = new Map<string, VideoJob>();
const JOB_TTL_MS = 6 * 60 * 60 * 1000;

let counter = 0;
const jobId = () => `${Date.now()}-${++counter}`;

async function dropJob(id: string): Promise<void> {
  const job = videoJobs.get(id);
  if (!job) return;
  videoJobs.delete(id);
  await fsp.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}

export function registerMontage(bot: Bot): void {
  // Брошенные задания подчищаем, чтобы не копить видео на диске.
  setInterval(
    () => {
      const now = Date.now();
      for (const [id, job] of videoJobs) {
        if (now - job.createdAt > JOB_TTL_MS) void dropJob(id);
      }
    },
    30 * 60 * 1000,
  ).unref?.();

  bot.on([":video", ":document"], async (ctx) => {
    const doc = ctx.message?.video ?? ctx.message?.document;
    if (!doc) return;
    const mime = "mime_type" in doc ? (doc.mime_type ?? "") : "video/mp4";
    if (!mime.startsWith("video/")) {
      return ctx.reply("Это не похоже на видео 🤔 Пришли видеофайл.");
    }

    const status = await ctx.reply(STAGE_TEXT.downloaded);
    const id = jobId();
    const jobDir = path.join(config.workDir, "uploads", id);
    await fsp.mkdir(jobDir, { recursive: true });
    const videoPath = path.join(jobDir, "source.mp4");

    try {
      await downloadTelegramFile(ctx, videoPath);
      log.ok(`Скачано: ${videoPath}`);
    } catch (e) {
      log.err(e);
      await fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
      await ctx.api.editMessageText(
        ctx.chat.id,
        status.message_id,
        STAGE_TEXT.error,
      );
      return;
    }

    videoJobs.set(id, {
      dir: jobDir,
      source: videoPath,
      caption: (ctx.message?.caption ?? "").trim(),
      createdAt: Date.now(),
    });

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      "Что делаем с роликом?",
      {
        reply_markup: new InlineKeyboard()
          .text("🎬 Смонтировать", `mv:${id}:montage`)
          .row()
          .text("📅 Запланировать публикацию", `mv:${id}:publish`)
          .row()
          .text("❌ Не надо", `mv:${id}:drop`),
      },
    );
  });

  bot.callbackQuery(/^mv:/, async (ctx) => {
    const [, id, action] = (ctx.callbackQuery.data ?? "").split(":");
    const job = videoJobs.get(id);
    if (!job) {
      await ctx.answerCallbackQuery("Ролик уже не в работе — пришли заново");
      return;
    }

    if (action === "drop") {
      await dropJob(id);
      await ctx.answerCallbackQuery("Удалила");
      await ctx.editMessageText("❌ Ролик удалён.");
      return;
    }

    if (action === "publish") {
      await ctx.answerCallbackQuery();
      // Готовый файл переезжает в content/media — оттуда его возьмёт планировщик.
      const relative = await adoptLocalFile(job.result ?? job.source);
      await dropJob(id);
      await startVideoDraft(ctx, relative, job.caption);
      return;
    }

    if (action !== "montage") return;

    await ctx.answerCallbackQuery();
    const setStage = async (s: Stage) => {
      try {
        await ctx.editMessageText(STAGE_TEXT[s]);
      } catch {
        /* игнорируем "message is not modified" */
      }
    };

    try {
      const output = await processVideo(job.source, job.dir, setStage);
      job.result = output;
      await ctx.replyWithVideo(new InputFile(output), {
        caption: "Готово 🎬 Русские субтитры + motion-дизайн.",
        reply_markup: new InlineKeyboard().text(
          "📅 Запланировать публикацию",
          `mv:${id}:publish`,
        ),
      });
    } catch (e) {
      log.err(e);
      await setStage("error");
      await dropJob(id);
    }
  });
}
