import { publishConfig } from "./config";
import { log } from "./logger";

// Уведомления о публикациях — в Telegram, тем же ботом, что и монтаж роликов.
// Не настроено (нет BOT_TOKEN/NOTIFY_CHAT_ID) — просто пишем в лог.

export async function notify(text: string): Promise<void> {
  const { botToken, chatId } = publishConfig.notify;
  if (!botToken || !chatId) {
    log.info(`(уведомление) ${text.replace(/\n/g, " ")}`);
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok)
      log.warn(`Не удалось отправить уведомление: HTTP ${res.status}`);
  } catch (e) {
    log.warn(`Не удалось отправить уведомление: ${(e as Error).message}`);
  }
}
