import fsp from "node:fs/promises";
import { Bot } from "grammy";
import { config } from "./config";
import { log } from "./logger";
import { registerPublishing } from "./publishing";
import { registerMontage } from "./montage";

// Точка входа бота: монтаж роликов + приём контента для автопубликации.

export function createBot(): Bot {
  const bot = new Bot(config.botToken);

  bot.command("start", (ctx) =>
    ctx.reply(
      "Привет! 👋 Я умею две вещи:\n\n" +
        "🎬 <b>Монтаж.</b> Пришли видео — наложу русские субтитры и motion-дизайн.\n" +
        "📅 <b>Публикация.</b> Пришли фото, карусель (несколько фото одним " +
        "сообщением) или видео с подписью — спрошу, куда и когда, и опубликую " +
        "сам в Instagram и ВКонтакте.\n\n" +
        "Команды:\n" +
        "/plan — что запланировано\n" +
        "/status — что уже опубликовано\n\n" +
        "⚠️ Telegram отдаёт ботам файлы до 20 МБ.",
      { parse_mode: "HTML" },
    ),
  );

  // Порядок важен: публикация ловит фото и текстовые ответы,
  // монтаж — видео. Оба набора обработчиков живут на одном боте.
  registerPublishing(bot);
  registerMontage(bot);

  bot.catch((err) => log.err("Bot error:", err.error));
  return bot;
}

async function main() {
  await fsp.mkdir(config.workDir, { recursive: true });

  // Планировщик автопубликации можно держать в этом же процессе —
  // тогда одного деплоя хватает и на монтаж роликов, и на выкладку.
  if (process.env.PUBLISH_SCHEDULER_IN_BOT === "true") {
    const { startScheduler } = await import("../publish/scheduler");
    void startScheduler();
  }

  log.info("Запускаю бота (long polling)…");
  await createBot().start({
    onStart: (me) => log.ok(`Бот @${me.username} на связи`),
  });
}

main().catch((e) => {
  log.err(e);
  process.exit(1);
});
