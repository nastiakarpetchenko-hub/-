/**
 * Самопроверка Telegram-сценария публикации — без реального бота и аккаунтов.
 *
 * Поднимает grammY с подменённым транспортом (ни один запрос не уходит в сеть),
 * скармливает ему настоящие апдейты Telegram — фото, альбом, видео, нажатия
 * кнопок, ответ текстом — и проверяет, что в контент-плане появляется верный
 * пост. Запуск: npm run bot:test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Update, UserFromGetMe } from "grammy/types";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "bot-selftest-"));
fs.mkdirSync(path.join(tmp, "content", "media"), { recursive: true });

process.env.BOT_TOKEN = "123456:TEST";
process.env.WORK_DIR = path.join(tmp, "work");
process.env.CONTENT_DIR = path.join(tmp, "content");
process.env.PLAN_FILE = path.join(tmp, "content", "plan.yaml");
process.env.STATE_FILE = path.join(tmp, "content", "state.json");
process.env.TIMEZONE = "Europe/Moscow";
process.env.IG_USER_ID = "1784140";
process.env.IG_ACCESS_TOKEN = "ig-test";
process.env.VK_GROUP_ID = "123456";
process.env.VK_ACCESS_TOKEN = "vk-test";

// ── Транспорт Telegram: ничего не отправляем, всё записываем ─────────
interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}
const apiCalls: ApiCall[] = [];
let messageSeq = 100;

const CHAT = { id: 42, type: "private" as const, first_name: "Настя" };
const USER = { id: 42, is_bot: false, first_name: "Настя" };
const BOT_INFO = {
  id: 1,
  is_bot: true,
  first_name: "Тест",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
} as unknown as UserFromGetMe;

globalThis.fetch = (async (input: string | URL | Request) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url.includes("api.telegram.org/file/")) {
    return new Response(new Uint8Array(2048), { status: 200 });
  }
  throw new Error(`тест: неожиданный сетевой запрос ${url}`);
}) as typeof fetch;

async function main() {
  const { Bot } = await import("grammy");
  const { registerPublishing } = await import("./publishing");
  const { registerMontage } = await import("./montage");
  const { loadPlan } = await import("../publish/plan");
  const { publishConfig } = await import("../publish/config");

  const bot = new Bot("123456:TEST", { botInfo: BOT_INFO });
  const errors: unknown[] = [];
  bot.catch((err) => errors.push(err.error));

  bot.api.config.use((async (
    _prev: unknown,
    method: string,
    payload: Record<string, unknown>,
  ) => {
    apiCalls.push({ method, payload });
    switch (method) {
      case "getFile":
        return {
          ok: true,
          result: {
            file_id: "f",
            file_unique_id: "u",
            file_path: "photos/x.jpg",
          },
        };
      case "sendMessage":
      case "sendVideo":
      case "sendPhoto":
        return {
          ok: true,
          result: {
            message_id: ++messageSeq,
            date: Math.floor(Date.now() / 1000),
            chat: CHAT,
            ...payload,
          },
        };
      default:
        return { ok: true, result: true };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);

  registerPublishing(bot);
  registerMontage(bot);
  await bot.init();

  // ── Помощники ──
  let updateId = 0;
  const photoUpdate = (caption?: string, mediaGroupId?: string): Update =>
    ({
      update_id: ++updateId,
      message: {
        message_id: ++messageSeq,
        date: Math.floor(Date.now() / 1000),
        chat: CHAT,
        from: USER,
        photo: [
          {
            file_id: "p1",
            file_unique_id: "pu1",
            width: 1080,
            height: 1350,
            file_size: 2048,
          },
        ],
        ...(caption ? { caption } : {}),
        ...(mediaGroupId ? { media_group_id: mediaGroupId } : {}),
      },
    }) as unknown as Update;

  const videoUpdate = (caption?: string): Update =>
    ({
      update_id: ++updateId,
      message: {
        message_id: ++messageSeq,
        date: Math.floor(Date.now() / 1000),
        chat: CHAT,
        from: USER,
        video: {
          file_id: "v1",
          file_unique_id: "vu1",
          width: 1080,
          height: 1920,
          duration: 30,
          mime_type: "video/mp4",
        },
        ...(caption ? { caption } : {}),
      },
    }) as unknown as Update;

  const textUpdate = (text: string): Update =>
    ({
      update_id: ++updateId,
      message: {
        message_id: ++messageSeq,
        date: Math.floor(Date.now() / 1000),
        chat: CHAT,
        from: USER,
        text,
        // Команды Telegram помечает entity — без неё grammY их не узнаёт.
        ...(text.startsWith("/")
          ? {
              entities: [
                {
                  type: "bot_command",
                  offset: 0,
                  length: text.split(" ")[0].length,
                },
              ],
            }
          : {}),
      },
    }) as unknown as Update;

  const pressUpdate = (data: string): Update =>
    ({
      update_id: ++updateId,
      callback_query: {
        id: `cb${updateId}`,
        from: USER,
        chat_instance: "ci",
        data,
        message: {
          message_id: messageSeq,
          date: Math.floor(Date.now() / 1000),
          chat: CHAT,
          from: BOT_INFO,
          text: "карточка",
        },
      },
    }) as unknown as Update;

  /** Кнопки последнего отправленного/перерисованного сообщения. */
  function lastButtons(): { text: string; data: string }[] {
    for (let i = apiCalls.length - 1; i >= 0; i--) {
      const markup = apiCalls[i].payload.reply_markup as
        | { inline_keyboard?: { text: string; callback_data: string }[][] }
        | undefined;
      if (markup?.inline_keyboard) {
        return markup.inline_keyboard
          .flat()
          .map((b) => ({ text: b.text, data: b.callback_data }));
      }
    }
    return [];
  }

  function lastText(): string {
    for (let i = apiCalls.length - 1; i >= 0; i--) {
      const { method, payload } = apiCalls[i];
      if (method === "sendMessage" || method === "editMessageText")
        return String(payload.text ?? "");
    }
    return "";
  }

  const press = async (match: string) => {
    const button = lastButtons().find(
      (b) => b.data.includes(match) || b.text.includes(match),
    );
    assert.ok(
      button,
      `не нашла кнопку «${match}» среди: ${lastButtons()
        .map((b) => b.text)
        .join(", ")}`,
    );
    await bot.handleUpdate(pressUpdate(button!.data));
  };

  let failures = 0;
  async function test(name: string, fn: () => Promise<void> | void) {
    apiCalls.length = 0;
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures++;
      console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    }
  }

  console.log("\nTelegram-сценарий публикации — самопроверка\n");

  // ── 1. Фото с подписью: карточка, площадки, время, сохранение ──
  await test("фото с подписью превращается в запланированный пост", async () => {
    await bot.handleUpdate(
      photoUpdate("Терраса у воды: собрали за три недели."),
    );

    assert.ok(
      lastText().includes("Новый пост"),
      "не показалась карточка поста",
    );
    assert.ok(
      lastText().includes("Терраса у воды"),
      "в карточке нет текста поста",
    );
    const buttons = lastButtons();
    assert.ok(
      buttons.some((b) => b.text.includes("Instagram")),
      "нет кнопки Instagram",
    );
    assert.ok(
      buttons.some((b) => b.text.includes("ВКонтакте")),
      "нет кнопки ВКонтакте",
    );

    await press("step:time");
    assert.ok(
      lastButtons().some((b) => b.text === "Завтра 10:00"),
      "нет быстрых слотов времени",
    );

    await press("Завтра 10:00");
    assert.ok(lastText().includes("завтра в 10:00"), "не выбралось время");

    await press("save");
    assert.ok(lastText().includes("Запланировано"), "нет подтверждения");

    const plan = loadPlan();
    assert.equal(
      plan.errors.length,
      0,
      `план с ошибками: ${plan.errors.join("; ")}`,
    );
    assert.equal(plan.posts.length, 1);
    const post = plan.posts[0];
    assert.equal(post.type, "photo");
    assert.deepEqual([...post.platforms].sort(), ["instagram", "vk"]);
    assert.equal(post.text, "Терраса у воды: собрали за три недели.");
    assert.equal(post.media.length, 1);
    assert.ok(
      fs.existsSync(path.resolve(publishConfig.contentDir, post.media[0])),
      "файл не сохранился в content/media",
    );
  });

  // ── 2. Снятие площадки ──
  await test("можно отключить площадку одной кнопкой", async () => {
    await bot.handleUpdate(photoUpdate("Только ВК"));
    await press("tg:instagram"); // снимаем галочку с Instagram
    assert.ok(
      lastText().includes("Куда: ВКонтакте"),
      `в карточке: ${lastText().split("\n")[3]}`,
    );
    await press("step:time");
    await press("Завтра 10:00");
    await press("save");

    const post = loadPlan().posts.find((p) => p.text === "Только ВК");
    assert.ok(post, "пост не сохранился");
    assert.deepEqual(post!.platforms, ["vk"]);
  });

  // ── 3. Альбом → карусель ──
  await test("несколько фото одним сообщением становятся каруселью", async () => {
    await bot.handleUpdate(photoUpdate("Три шага проектирования", "album-1"));
    await bot.handleUpdate(photoUpdate(undefined, "album-1"));
    await bot.handleUpdate(photoUpdate(undefined, "album-1"));
    await new Promise((r) => setTimeout(r, 3000)); // ждём сборку альбома

    assert.ok(
      lastText().includes("карусель"),
      `ожидала карусель, а в карточке: ${lastText()}`,
    );
    assert.ok(lastText().includes("3 файла"), "не собрались все три фото");

    await press("step:time");
    await press("Завтра 19:00");
    await press("save");

    const post = loadPlan().posts.find((p) => p.type === "carousel");
    assert.ok(post, "карусель не сохранилась");
    assert.equal(post!.media.length, 3);
  });

  // ── 4. Фото без подписи: текст и время словами ──
  await test("текст и время можно написать словами", async () => {
    await bot.handleUpdate(photoUpdate());
    assert.ok(
      lastText().includes("Пришли текст поста"),
      "бот не попросил текст",
    );

    await bot.handleUpdate(textUpdate("Открыли запись на следующий сезон"));
    assert.ok(
      lastText().includes("Открыли запись"),
      "текст не попал в карточку",
    );

    await press("step:time");
    await press("ask:time");
    await bot.handleUpdate(textUpdate("завтра в 9:30"));
    assert.ok(
      lastText().includes("завтра в 09:30"),
      `время не разобралось: ${lastText()}`,
    );

    await press("save");
    const post = loadPlan().posts.find(
      (p) => p.text === "Открыли запись на следующий сезон",
    );
    assert.ok(post, "пост не сохранился");
    assert.match(post!.whenRaw, /\d{4}-\d{2}-\d{2} 09:30/);
  });

  // ── 5. Непонятное время ──
  await test("непонятное время не ломает диалог", async () => {
    await bot.handleUpdate(photoUpdate("Проверка времени"));
    await press("step:time");
    await press("ask:time");
    await bot.handleUpdate(textUpdate("когда-нибудь потом"));
    assert.ok(
      lastText().includes("Не поняла время"),
      "бот не сообщил о непонятном времени",
    );

    await bot.handleUpdate(textUpdate("через 3 часа"));
    assert.ok(
      lastText().includes("Новый пост"),
      "после подсказки карточка не вернулась",
    );
    await press("cancel");
  });

  // ── 6. Видео: выбор «смонтировать» или «в план» ──
  await test("видео предлагает монтаж или публикацию", async () => {
    await bot.handleUpdate(videoUpdate("Ролик про террасу"));
    const buttons = lastButtons();
    assert.ok(
      buttons.some((b) => b.text.includes("Смонтировать")),
      "нет кнопки монтажа",
    );
    assert.ok(
      buttons.some((b) => b.text.includes("Запланировать")),
      "нет кнопки публикации",
    );

    await press("publish");
    assert.ok(
      lastText().includes("Новый пост"),
      "не открылась карточка публикации",
    );
    assert.ok(lastText().includes("ролик"), "тип поста не ролик");

    await press("step:time");
    await press("Завтра 10:00");
    await press("save");

    const post = loadPlan().posts.find((p) => p.type === "reel");
    assert.ok(post, "ролик не попал в план");
    assert.ok(
      fs.existsSync(path.resolve(publishConfig.contentDir, post!.media[0])),
      "видеофайл не переехал в content/media",
    );
  });

  // ── 7. /plan и удаление из плана ──
  await test("/plan показывает запланированное и умеет убирать посты", async () => {
    const before = loadPlan().posts.length;
    await bot.handleUpdate(textUpdate("/plan"));
    const planText = apiCalls
      .filter((c) => c.method === "sendMessage")
      .map((c) => String(c.payload.text))
      .join("\n");
    assert.ok(planText.includes("Запланировано постов"), "нет списка плана");

    const deleteButton = lastButtons().find((b) =>
      b.data.startsWith("pf:del:"),
    );
    assert.ok(deleteButton, "нет кнопки удаления");
    await bot.handleUpdate(pressUpdate(deleteButton!.data));
    assert.equal(
      loadPlan().posts.length,
      before - 1,
      "пост не убрался из плана",
    );
  });

  // ── 8. Отмена ──
  await test("отмена удаляет черновик и файл", async () => {
    await bot.handleUpdate(photoUpdate("Этот пост отменим"));
    const mediaBefore = fs.readdirSync(
      path.join(publishConfig.contentDir, "media"),
    ).length;
    await press("cancel");
    assert.ok(lastText().includes("удалён"), "нет подтверждения отмены");
    const mediaAfter = fs.readdirSync(
      path.join(publishConfig.contentDir, "media"),
    ).length;
    assert.equal(
      mediaAfter,
      mediaBefore - 1,
      "файл черновика остался на диске",
    );
    assert.ok(
      !loadPlan().posts.some((p) => p.text === "Этот пост отменим"),
      "отменённый пост попал в план",
    );
  });

  assert.equal(
    errors.length,
    0,
    `обработчики падали: ${errors.map(String).join("; ")}`,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("");
  if (failures) {
    console.error(`Провалено проверок: ${failures}`);
    process.exit(1);
  }
  console.log("Все проверки пройдены.\n");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
