import { publishConfig } from "./config";
import { log } from "./logger";
import { loadPlan, textFor } from "./plan";
import { prepareMedia } from "./media";
import { notify } from "./notify";
import { instagramPublisher } from "./platforms/instagram";
import { vkPublisher } from "./platforms/vk";
import {
  isExhausted,
  isPublished,
  getEntry,
  loadState,
  recordResult,
  recordSkipped,
  saveState,
} from "./state";
import { formatInZone } from "./tz";
import type {
  PlannedPost,
  PlatformId,
  PreparedMedia,
  Publisher,
  PublishResult,
} from "./types";

// Ядро автопубликации: берём посты, которым подошло время, и рассылаем их
// по площадкам. Всё построено вокруг двух правил:
//   • один пост на одну площадку публикуется ровно один раз (журнал state);
//   • ошибка одной площадки не мешает остальным.

export const publishers: Record<PlatformId, Publisher> = {
  instagram: instagramPublisher,
  vk: vkPublisher,
};

export interface RunOptions {
  /** «Сейчас» — параметр, чтобы тесты и --dry-run могли смотреть в будущее. */
  now?: Date;
  /** Ничего не отправлять, только показать план действий. */
  dryRun?: boolean;
  /** Публиковать только эти посты и игнорировать расписание. */
  only?: string[];
  /** Публиковать, даже если время уже сильно прошло. */
  force?: boolean;
}

export interface RunItem {
  postId: string;
  platform: PlatformId;
  status: "published" | "failed" | "skipped" | "dry-run";
  message: string;
  url?: string;
}

export interface RunSummary {
  items: RunItem[];
  planErrors: string[];
  planWarnings: string[];
}

/** Пауза между повторами растёт: 5, 10, 15 минут… */
function retryReady(attempts: number, lastAt: string, now: Date): boolean {
  const waitMs = attempts * 5 * 60 * 1000;
  return now.getTime() - new Date(lastAt).getTime() >= waitMs;
}

/** Какие площадки для этого поста нужно обработать прямо сейчас. */
function targetsFor(
  post: PlannedPost,
  state: ReturnType<typeof loadState>,
  now: Date,
  opts: RunOptions,
): { platform: PlatformId; skip?: string }[] {
  const out: { platform: PlatformId; skip?: string }[] = [];

  for (const platform of post.platforms) {
    if (isPublished(state, post.id, platform)) continue;

    const entry = getEntry(state, post.id, platform);
    if (entry?.status === "skipped" && !opts.force) continue;

    const publisher = publishers[platform];
    if (!publisher.isConfigured()) {
      out.push({
        platform,
        skip: `не настроены доступы: ${publisher.missingConfig().join(", ")}`,
      });
      continue;
    }

    if (!opts.only && !opts.force) {
      if (post.when.getTime() > now.getTime()) continue; // время ещё не пришло

      const lateMin = (now.getTime() - post.when.getTime()) / 60000;
      if (lateMin > publishConfig.graceMinutes) {
        out.push({
          platform,
          skip: `время публикации прошло больше ${publishConfig.graceMinutes} мин назад`,
        });
        continue;
      }
    }

    if (entry && entry.status === "failed") {
      if (isExhausted(state, post.id, platform)) {
        out.push({
          platform,
          skip: `исчерпаны попытки (${entry.attempts}): ${entry.error ?? ""}`,
        });
        continue;
      }
      if (!retryReady(entry.attempts, entry.at, now)) continue; // ждём паузу перед повтором
    }

    out.push({ platform });
  }

  return out;
}

async function prepareFor(post: PlannedPost, needsPublicUrl: boolean) {
  const media: PreparedMedia[] = [];
  for (const item of post.media)
    media.push(await prepareMedia(item, needsPublicUrl));
  const cover = post.cover
    ? await prepareMedia(post.cover, needsPublicUrl)
    : undefined;
  return { media, cover };
}

/** Один проход: опубликовать всё, чему подошло время. */
export async function runOnce(opts: RunOptions = {}): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? publishConfig.dryRun;
  const { posts, timezone, errors, warnings } = loadPlan();
  const state = loadState();
  const items: RunItem[] = [];

  for (const e of errors) log.err(`Контент-план: ${e}`);
  for (const w of warnings) log.warn(`Контент-план: ${w}`);

  const selected = opts.only
    ? posts.filter((p) => opts.only!.includes(p.id))
    : posts;
  if (opts.only) {
    const missing = opts.only.filter((id) => !posts.some((p) => p.id === id));
    for (const id of missing)
      items.push({
        postId: id,
        platform: "vk",
        status: "skipped",
        message: "пост с таким id не найден в плане",
      });
  }

  for (const post of selected) {
    const targets = targetsFor(post, state, now, opts);
    if (!targets.length) continue;

    const todo = targets.filter((t) => !t.skip).map((t) => t.platform);
    for (const t of targets) {
      if (!t.skip) continue;
      log.warn(`«${post.id}» → ${publishers[t.platform].label}: ${t.skip}`);
      if (!dryRun) {
        recordSkipped(state, post.id, t.platform, t.skip);
        saveState(state);
      }
      items.push({
        postId: post.id,
        platform: t.platform,
        status: "skipped",
        message: t.skip,
      });
    }
    if (!todo.length) continue;

    const when = formatInZone(post.when, timezone);
    log.info(`«${post.id}» (${when}, ${post.type}) → ${todo.join(", ")}`);

    if (dryRun) {
      for (const platform of todo) {
        items.push({
          postId: post.id,
          platform,
          status: "dry-run",
          message: `был бы опубликован: ${post.media.join(", ")} / «${textFor(post, platform).slice(0, 60)}…»`,
        });
      }
      continue;
    }

    // Медиа готовим один раз на пост: публичные ссылки нужны, только если
    // среди площадок есть Instagram.
    const needsPublicUrl = todo.some((p) => publishers[p].needsPublicUrls);
    let prepared: { media: PreparedMedia[]; cover?: PreparedMedia };
    try {
      prepared = await prepareFor(post, needsPublicUrl);
    } catch (e) {
      const message = `не удалось подготовить медиа: ${(e as Error).message}`;
      log.err(`«${post.id}»: ${message}`);
      for (const platform of todo) {
        recordResult(state, post.id, platform, { ok: false, error: message });
        items.push({ postId: post.id, platform, status: "failed", message });
      }
      saveState(state);
      await notify(`⚠️ <b>${post.id}</b>: ${message}`);
      continue;
    }

    for (const platform of todo) {
      const publisher = publishers[platform];
      let result: PublishResult;
      try {
        result = await publisher.publish({
          post,
          text: textFor(post, platform),
          media: prepared.media,
          cover: prepared.cover,
        });
      } catch (e) {
        result = { ok: false, error: (e as Error).message };
      }

      // Журнал пишем сразу после каждой площадки: если процесс упадёт,
      // уже опубликованное не уйдёт повторно.
      const entry = recordResult(state, post.id, platform, result);
      saveState(state);

      if (result.ok) {
        log.ok(
          `«${post.id}» → ${publisher.label}: опубликовано ${result.url ?? result.remoteId ?? ""}`,
        );
        items.push({
          postId: post.id,
          platform,
          status: "published",
          message: "опубликовано",
          url: result.url,
        });
        if (publishConfig.notify.onSuccess) {
          await notify(
            `✅ <b>${post.id}</b> → ${publisher.label}\n${result.url ?? ""}`,
          );
        }
      } else {
        const left = publishConfig.maxAttempts - entry.attempts;
        log.err(`«${post.id}» → ${publisher.label}: ${result.error}`);
        items.push({
          postId: post.id,
          platform,
          status: "failed",
          message: result.error ?? "ошибка",
        });
        await notify(
          `⚠️ <b>${post.id}</b> → ${publisher.label}\n${result.error}\n` +
            (left > 0
              ? `Попробую ещё ${left} раз(а).`
              : "Попытки исчерпаны — нужна ручная проверка."),
        );
      }
    }
  }

  return { items, planErrors: errors, planWarnings: warnings };
}
