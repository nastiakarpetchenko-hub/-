import { publishConfig } from "./config";
import { log } from "./logger";
import { loadPlan } from "./plan";
import { publishers, runOnce } from "./runner";
import { startScheduler } from "./scheduler";
import { getEntry, loadState } from "./state";
import { formatInZone } from "./tz";
import { stopLocalServer } from "./media";
import type { PlatformId } from "./types";

// Командная строка автопубликации.
//
//   npm run publish:check            — проверить план и доступы
//   npm run publish:run              — опубликовать всё, чему подошло время
//   npm run publish:run -- --dry-run — то же, но вхолостую
//   npm run publish -- now <id…>     — опубликовать конкретный пост прямо сейчас
//   npm run publish -- status        — что и куда уже ушло
//   npm run publish:scheduler        — постоянный режим по расписанию

const STATUS_ICON: Record<string, string> = {
  published: "✅",
  failed: "⚠️",
  skipped: "⏭",
};

function printPlan(): number {
  const { posts, timezone, errors, warnings } = loadPlan();
  const state = loadState();

  for (const p of Object.values(publishers)) {
    if (p.isConfigured()) log.ok(`${p.label}: доступы заданы`);
    else log.warn(`${p.label}: не заданы ${p.missingConfig().join(", ")}`);
  }
  if (
    publishConfig.media.host === "local" &&
    !publishConfig.media.publicBaseUrl
  ) {
    log.warn(
      "MEDIA_HOST=local, но PUBLIC_BASE_URL пуст — Instagram не сможет скачать файлы",
    );
  }

  console.log("");
  console.log(`Контент-план: ${publishConfig.planFile} (пояс ${timezone})`);
  console.log(`Постов: ${posts.length}`);
  console.log("");

  for (const post of posts) {
    const marks = post.platforms
      .map((platform: PlatformId) => {
        const entry = getEntry(state, post.id, platform);
        return `${publishers[platform].label}${entry ? ` ${STATUS_ICON[entry.status] ?? ""}` : ""}`;
      })
      .join(", ");
    console.log(
      `  ${formatInZone(post.when, timezone)}  ${post.type.padEnd(8)} ${post.id.padEnd(28)} → ${marks}`,
    );
  }

  if (warnings.length) {
    console.log("");
    for (const w of warnings) log.warn(w);
  }
  if (errors.length) {
    console.log("");
    for (const e of errors) log.err(e);
    console.log("");
    log.err(
      `Ошибок в плане: ${errors.length}. Эти посты опубликованы не будут.`,
    );
    return 1;
  }
  console.log("");
  log.ok("План в порядке.");
  return 0;
}

function printStatus(): void {
  const state = loadState();
  const ids = Object.keys(state.posts);
  if (!ids.length) {
    console.log("Журнал пуст — ещё ничего не публиковалось.");
    return;
  }
  for (const id of ids) {
    for (const [platform, entry] of Object.entries(state.posts[id])) {
      if (!entry) continue;
      const when = formatInZone(new Date(entry.at), publishConfig.timezone);
      console.log(
        `${STATUS_ICON[entry.status] ?? " "} ${id} → ${platform}: ${entry.status} (${when})` +
          (entry.url ? ` ${entry.url}` : "") +
          (entry.error ? ` — ${entry.error}` : ""),
      );
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const args = argv.filter((a) => !a.startsWith("--"));
  const command = args[0] ?? "scheduler";
  const dryRun = flags.has("--dry-run");

  switch (command) {
    case "check": {
      process.exitCode = printPlan();
      return;
    }
    case "status": {
      printStatus();
      return;
    }
    case "run": {
      const summary = await runOnce({ dryRun });
      const published = summary.items.filter(
        (i) => i.status === "published",
      ).length;
      const failed = summary.items.filter((i) => i.status === "failed").length;
      log.info(`Итог: опубликовано ${published}, ошибок ${failed}`);
      if (dryRun)
        for (const i of summary.items)
          console.log(`  [${i.platform}] ${i.postId}: ${i.message}`);
      if (failed) process.exitCode = 1;
      stopLocalServer();
      return;
    }
    case "now": {
      const ids = args.slice(1);
      if (!ids.length) {
        log.err("Укажи id постов: npm run publish -- now my-post-id");
        process.exitCode = 1;
        return;
      }
      const summary = await runOnce({ dryRun, only: ids, force: true });
      for (const i of summary.items)
        console.log(
          `  [${i.platform}] ${i.postId}: ${i.status} — ${i.message}`,
        );
      if (summary.items.some((i) => i.status === "failed"))
        process.exitCode = 1;
      stopLocalServer();
      return;
    }
    case "scheduler": {
      await startScheduler();
      return;
    }
    default: {
      console.log(
        [
          "Команды:",
          "  check                 проверить контент-план и доступы",
          "  run [--dry-run]       опубликовать всё, чему подошло время",
          "  now <id…> [--dry-run] опубликовать конкретные посты прямо сейчас",
          "  status                журнал публикаций",
          "  scheduler             постоянный режим по расписанию",
        ].join("\n"),
      );
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  log.err((e as Error).message);
  process.exitCode = 1;
});
