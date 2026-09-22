import { publishConfig } from "./config";
import { log } from "./logger";
import { publishers, runOnce } from "./runner";
import { notify } from "./notify";

// Планировщик: раз в SCHEDULER_INTERVAL_SEC смотрит контент-план и публикует
// всё, чему подошло время. Один процесс — держать его лучше рядом с ботом
// (или отдельным воркером на том же деплое).

export async function startScheduler(): Promise<void> {
  const ready = Object.values(publishers)
    .filter((p) => p.isConfigured())
    .map((p) => p.label);
  const notReady = Object.values(publishers)
    .filter((p) => !p.isConfigured())
    .map((p) => `${p.label} (нет ${p.missingConfig().join(", ")})`);

  log.ok(
    `Планировщик запущен. Пояс: ${publishConfig.timezone}, проверка раз в ${publishConfig.intervalSec} с`,
  );
  log.info(`План: ${publishConfig.planFile}`);
  if (ready.length) log.ok(`Готовы к публикации: ${ready.join(", ")}`);
  if (notReady.length) log.warn(`Не настроены: ${notReady.join("; ")}`);
  if (publishConfig.dryRun)
    log.warn("PUBLISH_DRY_RUN=true — ничего публиковаться не будет");

  let busy = false;
  const tick = async () => {
    if (busy) return; // предыдущий проход ещё идёт (заливка видео небыстрая)
    busy = true;
    try {
      await runOnce();
    } catch (e) {
      log.err(`Ошибка прохода планировщика: ${(e as Error).message}`);
      await notify(`⚠️ Планировщик: ${(e as Error).message}`);
    } finally {
      busy = false;
    }
  };

  await tick();
  const timer = setInterval(tick, publishConfig.intervalSec * 1000);

  const stop = () => {
    clearInterval(timer);
    log.info("Планировщик остановлен");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
