import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { InlineKeyboard, type Bot, type Context } from "grammy";
import { publishConfig } from "../publish/config";
import { appendPost, removePost, upcoming } from "../publish/planEdit";
import { LIMITS } from "../publish/plan";
import { formatHuman, quickSlots } from "../publish/humanTime";
import { publishers, runOnce } from "../publish/runner";
import { loadState } from "../publish/state";
import { formatInZone } from "../publish/tz";
import type { PlatformId, PostType } from "../publish/types";
import { downloadTelegramFile, extensionOf } from "./download";
import { log } from "./logger";

// Приём контента из Telegram: фото/видео + текст → пост в контент-плане.
//
// Весь диалог — это черновик (Draft) и одна карточка-сообщение, которая
// перерисовывается на каждом шаге: текст → площадки → время → подтверждение.
// После подтверждения пост дописывается в content/plan.yaml, а дальше его
// забирает планировщик — тот же, что публикует посты, заведённые руками.

type Step = "text" | "platforms" | "time" | "confirm";

interface Draft {
  id: string;
  chatId: number;
  /** Сообщение-карточка, которое перерисовываем. */
  messageId?: number;
  step: Step;
  type: PostType;
  /** Пути относительно content/ — в таком виде они попадут в план. */
  media: string[];
  text: string;
  platforms: PlatformId[];
  when?: Date;
  /** Ждём от человека обычное сообщение: текст поста или своё время. */
  awaiting?: "text" | "time";
  createdAt: number;
}

const drafts = new Map<string, Draft>();
const chatDraft = new Map<number, string>();
/** Альбомы Telegram приходят отдельными сообщениями — собираем их вместе. */
const albums = new Map<string, { draftId: string; timer: NodeJS.Timeout }>();

const ALBUM_WAIT_MS = 2500;
const DRAFT_TTL_MS = 6 * 60 * 60 * 1000;

const mediaDir = () => path.join(publishConfig.contentDir, "media");
const shortId = () => crypto.randomBytes(4).toString("hex");

const PLATFORM_LABEL: Record<PlatformId, string> = {
  instagram: "Instagram",
  vk: "ВКонтакте",
};

const TYPE_LABEL: Record<PostType, string> = {
  reel: "ролик",
  photo: "фото",
  carousel: "карусель",
};

// ── Черновики ────────────────────────────────────────────────────────

function newDraft(
  chatId: number,
  type: PostType,
  media: string[],
  text: string,
): Draft {
  const draft: Draft = {
    id: shortId(),
    chatId,
    step: text ? "platforms" : "text",
    type,
    media,
    text,
    // По умолчанию — все настроенные площадки: дублирование и есть смысл затеи.
    platforms: (Object.keys(publishers) as PlatformId[]).filter((p) =>
      publishers[p].isConfigured(),
    ),
    awaiting: text ? undefined : "text",
    createdAt: Date.now(),
  };
  if (!draft.platforms.length) draft.platforms = ["instagram", "vk"];
  drafts.set(draft.id, draft);
  chatDraft.set(chatId, draft.id);
  return draft;
}

function dropDraft(draft: Draft): void {
  drafts.delete(draft.id);
  if (chatDraft.get(draft.chatId) === draft.id) chatDraft.delete(draft.chatId);
}

/** Убираем брошенные черновики и их файлы, чтобы диск не зарастал. */
function sweepDrafts(): void {
  const now = Date.now();
  for (const draft of [...drafts.values()]) {
    if (now - draft.createdAt < DRAFT_TTL_MS) continue;
    for (const rel of draft.media) {
      fs.rmSync(path.resolve(publishConfig.contentDir, rel), { force: true });
    }
    dropDraft(draft);
  }
}

// ── Карточка черновика ───────────────────────────────────────────────

function cardText(draft: Draft): string {
  const lines = [`📅 <b>Новый пост</b>`, ``];
  lines.push(
    `Что: ${TYPE_LABEL[draft.type]}${draft.media.length > 1 ? ` (${draft.media.length} файла)` : ""}`,
  );
  lines.push(
    `Куда: ${draft.platforms.map((p) => PLATFORM_LABEL[p]).join(" + ") || "— не выбрано —"}`,
  );
  lines.push(
    `Когда: ${draft.when ? formatHuman(draft.when, publishConfig.timezone) : "— не выбрано —"}`,
  );
  lines.push(``);

  if (draft.step === "text") {
    lines.push(`✏️ Пришли текст поста ответным сообщением.`);
  } else {
    const preview =
      draft.text.length > 600 ? `${draft.text.slice(0, 600)}…` : draft.text;
    lines.push(`<b>Текст:</b>\n${escapeHtml(preview) || "— без текста —"}`);
  }

  if (draft.awaiting === "time") {
    lines.push(
      ``,
      `🕒 Напиши время: «завтра в 10:00», «23.09 18:30», «через 2 часа».`,
    );
  }
  return lines.join("\n");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cardKeyboard(draft: Draft): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cb = (action: string) => `pf:${draft.id}:${action}`;

  if (draft.step === "text") {
    return kb.text("Без текста", cb("notext")).text("❌ Отмена", cb("cancel"));
  }

  if (draft.step === "platforms") {
    const mark = (p: PlatformId) => (draft.platforms.includes(p) ? "✅" : "▫️");
    kb.text(`${mark("instagram")} Instagram`, cb("tg:instagram"))
      .text(`${mark("vk")} ВКонтакте`, cb("tg:vk"))
      .row()
      .text("Дальше →", cb("step:time"))
      .row()
      .text("✏️ Текст", cb("ask:text"))
      .text("❌ Отмена", cb("cancel"));
    return kb;
  }

  if (draft.step === "time") {
    const slots = quickSlots(publishConfig.timezone);
    slots.forEach((slot, i) => {
      kb.text(slot.label, cb(`at:${slot.date.getTime()}`));
      if (i % 2 === 1) kb.row();
    });
    kb.row().text("🕒 Своё время", cb("ask:time")).row();
    kb.text("← Назад", cb("step:platforms")).text("❌ Отмена", cb("cancel"));
    return kb;
  }

  return kb
    .text("✅ Запланировать", cb("save"))
    .row()
    .text("✏️ Текст", cb("ask:text"))
    .text("🕒 Время", cb("step:time"))
    .text("📍 Площадки", cb("step:platforms"))
    .row()
    .text("❌ Отмена", cb("cancel"));
}

async function showCard(ctx: Context, draft: Draft): Promise<void> {
  const options = {
    parse_mode: "HTML" as const,
    reply_markup: cardKeyboard(draft),
  };
  if (draft.messageId) {
    try {
      await ctx.api.editMessageText(
        draft.chatId,
        draft.messageId,
        cardText(draft),
        options,
      );
      return;
    } catch {
      // Сообщение могли удалить — просто отправим новое.
    }
  }
  const sent = await ctx.api.sendMessage(
    draft.chatId,
    cardText(draft),
    options,
  );
  draft.messageId = sent.message_id;
}

// ── Проверки перед сохранением ───────────────────────────────────────

function validate(draft: Draft): string | null {
  if (!draft.platforms.length) return "Не выбрана ни одна площадка.";
  if (!draft.when) return "Не выбрано время публикации.";
  if (!draft.media.length) return "К посту не приложен ни один файл.";

  if (draft.platforms.includes("instagram")) {
    if (draft.text.length > LIMITS.instagramCaption) {
      return `Подпись для Instagram — ${draft.text.length} символов, лимит ${LIMITS.instagramCaption}. Сократи текст или сними галочку с Instagram.`;
    }
    const tags = (draft.text.match(/#/g) ?? []).length;
    if (tags > LIMITS.instagramHashtags) {
      return `В Instagram максимум ${LIMITS.instagramHashtags} хештегов, в тексте ${tags}.`;
    }
  }
  if (
    draft.type === "carousel" &&
    (draft.media.length < LIMITS.carouselMin ||
      draft.media.length > LIMITS.carouselMax)
  ) {
    return `В карусели должно быть от ${LIMITS.carouselMin} до ${LIMITS.carouselMax} файлов.`;
  }
  const notConfigured = draft.platforms.filter(
    (p) => !publishers[p].isConfigured(),
  );
  if (notConfigured.length) {
    return `Не настроены доступы: ${notConfigured
      .map(
        (p) =>
          `${PLATFORM_LABEL[p]} (${publishers[p].missingConfig().join(", ")})`,
      )
      .join("; ")}. Пост сохранится, но опубликован не будет.`;
  }
  return null;
}

// ── Приём файлов ─────────────────────────────────────────────────────

/** Сохраняет файл из Telegram в content/media и возвращает путь для плана. */
async function saveIncoming(
  ctx: Context,
  fallbackExt: string,
  fileName?: string,
): Promise<string> {
  await fsp.mkdir(mediaDir(), { recursive: true });
  const name = `tg-${Date.now()}-${shortId()}${extensionOf(fileName, fallbackExt)}`;
  await downloadTelegramFile(ctx, path.join(mediaDir(), name));
  return `media/${name}`;
}

/** Кладёт уже готовый локальный файл (например, смонтированный ролик) в content/media. */
export async function adoptLocalFile(
  sourcePath: string,
  ext = ".mp4",
): Promise<string> {
  await fsp.mkdir(mediaDir(), { recursive: true });
  const name = `reel-${Date.now()}-${shortId()}${ext}`;
  await fsp.copyFile(sourcePath, path.join(mediaDir(), name));
  return `media/${name}`;
}

/** Начинает черновик для готового видеофайла (после монтажа или без него). */
export async function startVideoDraft(
  ctx: Context,
  relativeMedia: string,
  caption: string,
): Promise<void> {
  const draft = newDraft(ctx.chat!.id, "reel", [relativeMedia], caption.trim());
  await showCard(ctx, draft);
}

// ── Регистрация обработчиков ─────────────────────────────────────────

export function registerPublishing(bot: Bot): void {
  setInterval(sweepDrafts, 30 * 60 * 1000).unref?.();

  // ── /plan — что запланировано ──
  bot.command("plan", async (ctx) => {
    const items = upcoming(10);
    if (!items.length) {
      return ctx.reply(
        "План пуст. Пришли фото или видео — предложу запланировать публикацию.",
      );
    }
    await ctx.reply(`📅 Запланировано постов: ${items.length}`);
    for (const { post, started } of items) {
      const text = [
        `<b>${formatHuman(post.when, publishConfig.timezone)}</b> — ${TYPE_LABEL[post.type]}`,
        `${post.platforms.map((p) => PLATFORM_LABEL[p]).join(" + ")}`,
        ``,
        escapeHtml(post.text.slice(0, 300)),
      ].join("\n");
      const kb = new InlineKeyboard()
        .text("🚀 Опубликовать сейчас", `pf:now:${post.id}`)
        .row()
        .text("❌ Убрать из плана", `pf:del:${post.id}`);
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: started ? undefined : kb,
      });
    }
  });

  // ── /status — что уже вышло ──
  bot.command("status", async (ctx) => {
    const state = loadState();
    const rows: string[] = [];
    for (const [postId, byPlatform] of Object.entries(state.posts)) {
      for (const [platform, entry] of Object.entries(byPlatform)) {
        if (!entry) continue;
        const icon =
          entry.status === "published"
            ? "✅"
            : entry.status === "failed"
              ? "⚠️"
              : "⏭";
        rows.push(
          `${icon} ${formatInZone(new Date(entry.at), publishConfig.timezone)} · ${postId}\n` +
            `   ${PLATFORM_LABEL[platform as PlatformId]}: ${entry.url ?? entry.error ?? entry.status}`,
        );
      }
    }
    await ctx.reply(
      rows.length
        ? rows.slice(-20).join("\n")
        : "Пока ничего не публиковалось.",
    );
  });

  // ── Фото (в том числе альбомы-карусели) ──
  bot.on(":photo", async (ctx) => {
    const groupId = ctx.message?.media_group_id;
    let relative: string;
    try {
      relative = await saveIncoming(ctx, ".jpg");
    } catch (e) {
      log.err(e);
      return ctx.reply(`Не смог забрать фото: ${(e as Error).message}`);
    }
    const caption = (ctx.message?.caption ?? "").trim();

    // Альбом: собираем все фото в один черновик-карусель.
    if (groupId) {
      const existing = albums.get(groupId);
      if (existing) {
        const draft = drafts.get(existing.draftId);
        if (draft) {
          draft.media.push(relative);
          draft.type = draft.media.length > 1 ? "carousel" : "photo";
          if (!draft.text && caption) {
            draft.text = caption;
            draft.step = "platforms";
            draft.awaiting = undefined;
          }
        }
        clearTimeout(existing.timer);
        existing.timer = setTimeout(
          () => void finishAlbum(ctx, groupId),
          ALBUM_WAIT_MS,
        );
        return;
      }
      const draft = newDraft(ctx.chat!.id, "photo", [relative], caption);
      albums.set(groupId, {
        draftId: draft.id,
        timer: setTimeout(() => void finishAlbum(ctx, groupId), ALBUM_WAIT_MS),
      });
      return;
    }

    const draft = newDraft(ctx.chat!.id, "photo", [relative], caption);
    await showCard(ctx, draft);
  });

  async function finishAlbum(ctx: Context, groupId: string): Promise<void> {
    const album = albums.get(groupId);
    albums.delete(groupId);
    if (!album) return;
    const draft = drafts.get(album.draftId);
    if (!draft) return;
    draft.type = draft.media.length > 1 ? "carousel" : "photo";
    await showCard(ctx, draft);
  }

  // ── Кнопки ──
  bot.callbackQuery(/^pf:/, async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    const [, first, ...rest] = data.split(":");

    // Кнопки из /plan работают с постами, а не с черновиками.
    if (first === "del" || first === "now") {
      const postId = rest.join(":");
      if (first === "del") {
        const removed = removePost(postId);
        await ctx.answerCallbackQuery(
          removed ? "Убрала из плана" : "Пост уже не в плане",
        );
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        return;
      }
      await ctx.answerCallbackQuery("Публикую…");
      await ctx.reply("🚀 Публикую, это может занять пару минут…");
      const summary = await runOnce({ only: [postId], force: true });
      const lines = summary.items.map(
        (i) =>
          `${i.status === "published" ? "✅" : "⚠️"} ${PLATFORM_LABEL[i.platform]}: ${i.url ?? i.message}`,
      );
      await ctx.reply(
        lines.join("\n") || "Нечего публиковать: пост уже вышел.",
      );
      return;
    }

    const draft = drafts.get(first);
    if (!draft) {
      await ctx.answerCallbackQuery("Черновик устарел — пришли файл заново");
      return;
    }
    const action = rest.join(":");

    if (action === "cancel") {
      for (const rel of draft.media) {
        fs.rmSync(path.resolve(publishConfig.contentDir, rel), { force: true });
      }
      dropDraft(draft);
      await ctx.answerCallbackQuery("Отменила");
      await ctx.editMessageText("❌ Черновик удалён.");
      return;
    }

    if (action.startsWith("tg:")) {
      const platform = action.slice(3) as PlatformId;
      draft.platforms = draft.platforms.includes(platform)
        ? draft.platforms.filter((p) => p !== platform)
        : [...draft.platforms, platform];
    } else if (action === "step:time") {
      draft.step = "time";
      draft.awaiting = undefined;
    } else if (action === "step:platforms") {
      draft.step = "platforms";
      draft.awaiting = undefined;
    } else if (action === "ask:text") {
      draft.step = "text";
      draft.awaiting = "text";
    } else if (action === "notext") {
      draft.text = "";
      draft.step = "platforms";
      draft.awaiting = undefined;
    } else if (action === "ask:time") {
      draft.step = "time";
      draft.awaiting = "time";
    } else if (action.startsWith("at:")) {
      draft.when = new Date(Number(action.slice(3)));
      draft.step = "confirm";
      draft.awaiting = undefined;
    } else if (action === "save") {
      const problem = validate(draft);
      if (problem && !problem.startsWith("Не настроены доступы")) {
        await ctx.answerCallbackQuery({ text: problem, show_alert: true });
        return;
      }
      const id = appendPost({
        when: draft.when!,
        type: draft.type,
        platforms: draft.platforms,
        media: draft.media,
        text: draft.text,
      });
      dropDraft(draft);
      await ctx.answerCallbackQuery("Запланировано");
      await ctx.editMessageText(
        `✅ Запланировано на <b>${formatHuman(draft.when!, publishConfig.timezone)}</b>\n` +
          `${draft.platforms.map((p) => PLATFORM_LABEL[p]).join(" + ")}\n\n` +
          (problem ? `⚠️ ${problem}\n\n` : "") +
          `Посмотреть план — /plan`,
        { parse_mode: "HTML" },
      );
      log.ok(`Через Telegram добавлен пост «${id}»`);
      return;
    }

    await ctx.answerCallbackQuery();
    await showCard(ctx, draft);
  });

  // ── Обычные сообщения: текст поста или своё время ──
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return next();

    const draftId = chatDraft.get(ctx.chat.id);
    const draft = draftId ? drafts.get(draftId) : undefined;
    if (!draft || !draft.awaiting) return next();

    if (draft.awaiting === "text") {
      draft.text = text;
      draft.awaiting = undefined;
      draft.step = draft.when ? "confirm" : "platforms";
      await showCard(ctx, draft);
      return;
    }

    const { parseHumanTime } = await import("../publish/humanTime");
    const when = parseHumanTime(text, publishConfig.timezone);
    if (!when) {
      await ctx.reply(
        "Не поняла время 🤔 Напиши так: «завтра в 10:00», «23.09 18:30» или «через 2 часа».",
      );
      return;
    }
    if (when.getTime() < Date.now() - 60_000) {
      await ctx.reply("Это время уже прошло. Назови время в будущем.");
      return;
    }
    draft.when = when;
    draft.awaiting = undefined;
    draft.step = "confirm";
    await showCard(ctx, draft);
  });
}
