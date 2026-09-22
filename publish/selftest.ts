/**
 * Самопроверка автопубликации без реальных аккаунтов.
 *
 * Поднимает временную папку контента, подменяет сетевые вызовы заглушками
 * Instagram Graph API и VK API и прогоняет весь путь: план → подготовка
 * медиа → публикация → журнал. Запуск: npm run publish:test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Временное окружение (переменные должны быть заданы до импорта модулей) ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "publish-selftest-"));
fs.mkdirSync(path.join(tmp, "media"), { recursive: true });
for (const f of ["terrace.mp4", "cover.jpg", "a.jpg", "b.jpg", "photo.jpg"]) {
  fs.writeFileSync(path.join(tmp, "media", f), Buffer.alloc(1024, 7));
}

process.env.CONTENT_DIR = tmp;
process.env.PLAN_FILE = path.join(tmp, "plan.yaml");
process.env.STATE_FILE = path.join(tmp, "state.json");
process.env.TIMEZONE = "Europe/Moscow";
process.env.MEDIA_HOST = "local";
process.env.PUBLIC_BASE_URL = "https://media.test";
process.env.MEDIA_PORT = "0";
process.env.IG_USER_ID = "17841400000000000";
process.env.IG_ACCESS_TOKEN = "ig-test-token";
process.env.IG_VIDEO_TIMEOUT_SEC = "30";
process.env.VK_GROUP_ID = "123456";
process.env.VK_ACCESS_TOKEN = "vk-test-token";
// Включаем Клипы, чтобы проверить откат на обычное видео, если метод закрыт.
process.env.VK_CLIPS_FOR_REELS = "true";
process.env.NOTIFY_CHAT_ID = "";
process.env.PUBLISH_MAX_ATTEMPTS = "3";
process.env.PUBLISH_GRACE_MIN = "180";

// ── Заглушки сети ───────────────────────────────────────────────────
const calls: { method: string; url: string; body?: string }[] = [];
let igShouldFail = false;
let containerSeq = 0;
let mediaSeq = 0;

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const realFetch = globalThis.fetch;

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method = (init?.method ?? "GET").toUpperCase();
  const body =
    typeof init?.body === "string"
      ? init.body
      : init?.body instanceof URLSearchParams
        ? init.body.toString()
        : undefined;
  calls.push({ method, url, body });

  // ── Instagram Graph API ──
  if (url.includes("graph.facebook.com")) {
    if (url.includes("content_publishing_limit")) {
      return json({ data: [{ quota_usage: 1, config: { quota_total: 50 } }] });
    }
    if (igShouldFail) {
      return json({
        error: { message: "The image is too small", code: 36003 },
      });
    }
    if (url.includes("/media_publish"))
      return json({ id: `ig-media-${++mediaSeq}` });
    if (/\/media$/.test(url.split("?")[0]))
      return json({ id: `cont-${++containerSeq}` });
    if (url.includes("fields=status_code"))
      return json({ status_code: "FINISHED" });
    if (url.includes("fields=permalink"))
      return json({ permalink: "https://www.instagram.com/p/TEST/" });
    return json({ id: "unknown" });
  }

  // ── VK API ──
  if (url.includes("api.vk.com/method/")) {
    const method_ = url.split("/method/")[1];
    switch (method_) {
      case "photos.getWallUploadServer":
        return json({
          response: { upload_url: "https://vk-upload.test/photo" },
        });
      case "photos.saveWallPhoto":
        return json({ response: [{ owner_id: -123456, id: 789 }] });
      case "video.save":
        return json({
          response: {
            upload_url: "https://vk-upload.test/video",
            owner_id: -123456,
            video_id: 555,
          },
        });
      // Клипы: у большинства приложений метод закрыт — проверяем откат на видео.
      case "shortVideo.create":
        return json({
          error: { error_code: 3, error_msg: "Unknown method passed" },
        });
      case "wall.post":
        return json({ response: { post_id: 42 } });
      default:
        return json({
          error: { error_code: 100, error_msg: `не ожидал метод ${method_}` },
        });
    }
  }
  if (url.startsWith("https://vk-upload.test/photo")) {
    return json({ server: 123, photo: "[]", hash: "abc" });
  }
  if (url.startsWith("https://vk-upload.test/video"))
    return json({ size: 1024 });

  throw new Error(`тест: неожиданный запрос ${method} ${url}`);
}) as typeof fetch;

// ── Импортируем модули уже с подготовленным окружением ──────────────
// (tsx исполняет файл как CommonJS, поэтому всё асинхронное — внутри main)
async function main() {
  const { publishConfig } = await import("./config");
  const { parsePlanTime } = await import("./tz");
  const { loadPlan } = await import("./plan");
  const { runOnce } = await import("./runner");
  const { loadState } = await import("./state");
  const { stopLocalServer } = await import("./media");

  let failures = 0;
  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failures++;
      console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
    }
  }

  /** Тело form-запроса в читаемом виде (URLSearchParams кодирует пробел как «+»). */
  function formBody(call?: { body?: string }): string {
    return decodeURIComponent((call?.body ?? "").replace(/\+/g, " "));
  }

  /** Время «пять минут назад» в формате плана (по московскому поясу). */
  function minutesAgo(min: number): string {
    const d = new Date(Date.now() - min * 60_000);
    const p = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Europe/Moscow",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
    return p.replace("T", " ");
  }

  function writePlan(yaml: string) {
    fs.writeFileSync(publishConfig.planFile, yaml, "utf8");
  }

  console.log("\nАвтопубликация — самопроверка\n");

  // ── 1. Время ────────────────────────────────────────────────────────
  await test("время из плана переводится в UTC по часовому поясу", () => {
    assert.equal(
      parsePlanTime("2026-09-23 10:00", "Europe/Moscow").toISOString(),
      "2026-09-23T07:00:00.000Z",
    );
    assert.equal(
      parsePlanTime("2026-01-15 12:30", "Europe/Berlin").toISOString(),
      "2026-01-15T11:30:00.000Z",
    );
    assert.equal(
      parsePlanTime("2026-07-15T09:00:00Z", "Europe/Moscow").toISOString(),
      "2026-07-15T09:00:00.000Z",
    );
  });

  await test("время, написанное словами, понимается правильно", async () => {
    const { parseHumanTime, formatHuman } = await import("./humanTime");
    const tz = "Europe/Moscow";
    // Опора — фиксированный момент: 22 сентября 2026, 12:00 по Москве.
    const now = new Date("2026-09-22T09:00:00Z");

    const iso = (v: Date | null) => v?.toISOString() ?? "null";
    assert.equal(
      iso(parseHumanTime("завтра в 10:00", tz, now)),
      "2026-09-23T07:00:00.000Z",
    );
    assert.equal(
      iso(parseHumanTime("завтра 9:30", tz, now)),
      "2026-09-23T06:30:00.000Z",
    );
    assert.equal(
      iso(parseHumanTime("сегодня 19:00", tz, now)),
      "2026-09-22T16:00:00.000Z",
    );
    assert.equal(
      iso(parseHumanTime("послезавтра 8:00", tz, now)),
      "2026-09-24T05:00:00.000Z",
    );
    assert.equal(
      iso(parseHumanTime("23.09 18:30", tz, now)),
      "2026-09-23T15:30:00.000Z",
    );
    assert.equal(
      iso(parseHumanTime("23.09.2027 18:30", tz, now)),
      "2027-09-23T15:30:00.000Z",
    );
    assert.equal(
      iso(parseHumanTime("через 3 часа", tz, now)),
      "2026-09-22T12:00:00.000Z",
    );
    assert.equal(
      iso(parseHumanTime("через 20 минут", tz, now)),
      "2026-09-22T09:20:00.000Z",
    );
    assert.equal(
      iso(parseHumanTime("2026-10-01 07:15", tz, now)),
      "2026-10-01T04:15:00.000Z",
    );

    // «10:00» уже прошло сегодня → имеется в виду завтра.
    assert.equal(
      iso(parseHumanTime("10:00", tz, now)),
      "2026-09-23T07:00:00.000Z",
    );
    // «20:00» ещё впереди → сегодня.
    assert.equal(
      iso(parseHumanTime("20:00", tz, now)),
      "2026-09-22T17:00:00.000Z",
    );
    // Дата без года, которая уже прошла → следующий год.
    assert.equal(
      iso(parseHumanTime("01.03 09:00", tz, now)),
      "2027-03-01T06:00:00.000Z",
    );

    assert.equal(parseHumanTime("когда-нибудь", tz, now), null);
    assert.equal(parseHumanTime("25:00", tz, now), null);

    assert.equal(
      formatHuman(new Date("2026-09-23T07:00:00Z"), tz, now),
      "завтра в 10:00",
    );
    assert.equal(
      formatHuman(new Date("2026-09-22T16:00:00Z"), tz, now),
      "сегодня в 19:00",
    );
    assert.equal(
      formatHuman(new Date("2026-10-05T07:00:00Z"), tz, now),
      "05.10 в 10:00",
    );
  });

  // ── 2. Проверки контент-плана ───────────────────────────────────────
  await test("план с ошибками не публикуется, ошибки описаны по-человечески", () => {
    writePlan(`
timezone: Europe/Moscow
posts:
  - id: no-file
    when: 2026-09-23 10:00
    type: photo
    platforms: [vk]
    media: [media/missing.jpg]
    text: нет такого файла
  - id: reel-with-photo
    when: 2026-09-23 11:00
    type: reel
    platforms: [vk]
    media: [media/a.jpg]
    text: для reel нужно видео
  - id: small-carousel
    when: 2026-09-23 12:00
    type: carousel
    platforms: [vk]
    media: [media/a.jpg]
    text: мало файлов
  - id: bad-platform
    when: 2026-09-23 13:00
    type: photo
    platforms: [facebook]
    media: [media/a.jpg]
    text: неизвестная площадка
  - id: bad-date
    when: 23 сентября
    type: photo
    platforms: [vk]
    media: [media/a.jpg]
    text: непонятная дата
  - id: ok-post
    when: 2026-09-23 14:00
    type: photo
    platforms: [vk]
    media: [media/a.jpg]
    text: этот пост валидный
`);
    const plan = loadPlan();
    assert.equal(
      plan.posts.length,
      1,
      "валидным должен остаться ровно один пост",
    );
    assert.equal(plan.posts[0].id, "ok-post");
    assert.equal(
      plan.errors.length,
      5,
      `ожидал 5 ошибок, получил ${plan.errors.length}`,
    );
    assert.ok(plan.errors.some((e) => e.includes("файл не найден")));
    assert.ok(plan.errors.some((e) => e.includes("для reel нужен видеофайл")));
  });

  await test("дубли id ловятся до публикации", () => {
    writePlan(`
posts:
  - { id: same, when: 2026-09-23 10:00, type: photo, platforms: [vk], media: [media/a.jpg], text: раз }
  - { id: same, when: 2026-09-23 11:00, type: photo, platforms: [vk], media: [media/b.jpg], text: два }
`);
    const plan = loadPlan();
    assert.equal(plan.posts.length, 1);
    assert.ok(plan.errors.some((e) => e.includes("уже есть")));
  });

  // ── 3. Основной план: reel + карусель + пост только в ВК ────────────
  const mainPlan = `
timezone: Europe/Moscow
defaults:
  platforms: [instagram, vk]
  tags: [ландшафт]
posts:
  - id: reel-1
    when: ${minutesAgo(5)}
    type: reel
    media: [media/terrace.mp4]
    cover: media/cover.jpg
    text: Терраса у воды
  - id: carousel-1
    when: ${minutesAgo(4)}
    type: carousel
    media: [media/a.jpg, media/b.jpg]
    text: Три шага
    overrides:
      vk:
        text: Развёрнутый текст для ВК
        tags: [проектирование]
  - id: vk-only-1
    when: ${minutesAgo(3)}
    type: photo
    platforms: [vk]
    media: [media/photo.jpg]
    text: Только ВК
  - id: future-1
    when: ${minutesAgo(-120)}
    type: photo
    media: [media/photo.jpg]
    text: Ещё не время
`;

  await test("--dry-run ничего не отправляет в сеть", async () => {
    writePlan(mainPlan);
    calls.length = 0;
    const summary = await runOnce({ dryRun: true });
    assert.equal(calls.length, 0, "в dry-run не должно быть сетевых запросов");
    assert.equal(summary.planErrors.length, 0);
    const dry = summary.items.filter((i) => i.status === "dry-run");
    assert.equal(
      dry.length,
      5,
      `ожидал 5 планируемых публикаций, получил ${dry.length}`,
    );
    assert.ok(
      !fs.existsSync(publishConfig.stateFile),
      "в dry-run журнал не пишется",
    );
  });

  await test("публикация: Instagram и ВКонтакте получают свои посты", async () => {
    calls.length = 0;
    const summary = await runOnce();
    const published = summary.items.filter((i) => i.status === "published");
    assert.equal(
      published.length,
      5,
      `ожидал 5 публикаций, получил ${published.length}`,
    );

    // Будущий пост не трогаем.
    assert.ok(!summary.items.some((i) => i.postId === "future-1"));

    // Instagram: reel → контейнер REELS с обложкой, затем media_publish.
    const igReel = calls.find((c) => c.body?.includes("media_type=REELS"));
    assert.ok(igReel, "не нашёл создание контейнера REELS");
    assert.ok(igReel!.body!.includes("cover_url"), "обложка reel не передана");
    assert.ok(formBody(igReel).includes("video_url=https://media.test/m/"));

    // Instagram: карусель → 2 дочерних контейнера + родительский CAROUSEL.
    const carouselChildren = calls.filter((c) =>
      c.body?.includes("is_carousel_item=true"),
    );
    assert.equal(carouselChildren.length, 2);
    const carouselParent = calls.find((c) =>
      c.body?.includes("media_type=CAROUSEL"),
    );
    assert.ok(carouselParent, "не нашёл родительский контейнер карусели");
    assert.equal(
      calls.filter((c) => c.url.includes("media_publish")).length,
      2,
      "в Instagram ушло не 2 поста",
    );

    // ВКонтакте: видео заливается через video.save (Клип недоступен → откат).
    assert.ok(
      calls.some((c) => c.url.includes("shortVideo.create")),
      "не было попытки залить Клип",
    );
    assert.ok(
      calls.some((c) => c.url.includes("video.save")),
      "не было отката на обычное видео",
    );
    const wallPosts = calls.filter((c) => c.url.includes("wall.post"));
    assert.equal(wallPosts.length, 3, "в ВК должно уйти 3 записи");

    // Текст под площадку: в ВК — переопределённый, в Instagram — общий.
    const vkCarousel = wallPosts.find((c) =>
      formBody(c).includes("Развёрнутый текст"),
    );
    assert.ok(vkCarousel, "в ВК не ушёл переопределённый текст карусели");
    assert.ok(formBody(vkCarousel).includes("#проектирование"));
    assert.ok(formBody(carouselParent).includes("#ландшафт"));

    // Вложения ВК собраны и переданы одной записью.
    assert.ok(
      formBody(vkCarousel).includes("photo-123456_789,photo-123456_789"),
    );

    // Ссылки на посты попали в журнал.
    const state = loadState();
    assert.equal(state.posts["reel-1"].instagram?.status, "published");
    assert.equal(
      state.posts["reel-1"].instagram?.url,
      "https://www.instagram.com/p/TEST/",
    );
    assert.equal(
      state.posts["reel-1"].vk?.url,
      "https://vk.com/wall-123456_42",
    );
    assert.equal(
      state.posts["vk-only-1"].instagram,
      undefined,
      "пост для ВК не должен уходить в Instagram",
    );
  });

  await test("повторный запуск ничего не публикует заново", async () => {
    calls.length = 0;
    const summary = await runOnce();
    assert.equal(
      calls.length,
      0,
      `повторный проход сделал ${calls.length} запросов`,
    );
    assert.equal(summary.items.length, 0);
  });

  // ── 4. Ошибки площадки ──────────────────────────────────────────────
  await test("ошибка Instagram не мешает ВК и фиксируется в журнале", async () => {
    publishConfig.planFile = path.join(tmp, "plan-fail.yaml");
    publishConfig.stateFile = path.join(tmp, "state-fail.json");
    fs.writeFileSync(
      publishConfig.planFile,
      `
posts:
  - id: fail-1
    when: ${minutesAgo(2)}
    type: photo
    platforms: [instagram, vk]
    media: [media/a.jpg]
    text: Проверка ошибки
`,
      "utf8",
    );

    igShouldFail = true;
    const summary = await runOnce();
    igShouldFail = false;

    const ig = summary.items.find((i) => i.platform === "instagram");
    const vk = summary.items.find((i) => i.platform === "vk");
    assert.equal(ig?.status, "failed");
    assert.ok(ig?.message.includes("The image is too small"));
    assert.equal(
      vk?.status,
      "published",
      "ВК должен опубликоваться, несмотря на ошибку Instagram",
    );

    const state = loadState();
    assert.equal(state.posts["fail-1"].instagram?.attempts, 1);
    assert.equal(state.posts["fail-1"].vk?.status, "published");
  });

  await test("после ошибки повтор идёт не сразу, а с паузой", async () => {
    calls.length = 0;
    const summary = await runOnce();
    assert.equal(summary.items.length, 0, "повтор должен подождать паузу");

    // …а через шесть минут — пробует снова и публикует.
    const later = new Date(Date.now() + 6 * 60_000);
    const retry = await runOnce({ now: later });
    const ig = retry.items.find((i) => i.platform === "instagram");
    assert.equal(
      ig?.status,
      "published",
      "после паузы Instagram должен опубликоваться",
    );
    assert.equal(loadState().posts["fail-1"].instagram?.attempts, 2);
  });

  // ── Итог ────────────────────────────────────────────────────────────
  stopLocalServer();
  globalThis.fetch = realFetch;
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log("");
  if (failures) {
    console.error(`Провалено проверок: ${failures}`);
    process.exit(1);
  }
  console.log("Все проверки пройдены.\n");
  process.exit(0);
}

main();
