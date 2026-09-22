// Работа со временем контент-плана.
// В плане время пишется «по-человечески» («2026-09-23 10:00») и трактуется
// в часовом поясе TIMEZONE (по умолчанию Europe/Moscow). Здесь — перевод
// такого времени в UTC и обратно, без внешних библиотек.

/** Смещение часового пояса (мс) в конкретный момент времени. */
function offsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, number> = {};
  for (const { type, value } of dtf.formatToParts(new Date(utcMs))) {
    if (type !== "literal") p[type] = Number(value);
  }
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - utcMs;
}

/** Проверка, что такой часовой пояс вообще существует. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ABSOLUTE_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Разбирает время из плана.
 * «2026-09-23 10:00» → момент 10:00 в указанном поясе.
 * «2026-09-23T10:00:00+03:00» / «…Z» → берётся как есть.
 */
export function parsePlanTime(raw: string, timeZone: string): Date {
  const value = raw.trim();

  if (ABSOLUTE_RE.test(value)) {
    const d = new Date(value.replace(" ", "T"));
    if (Number.isNaN(d.getTime()))
      throw new Error(`не разобрать дату: «${raw}»`);
    return d;
  }

  const m = LOCAL_RE.exec(value);
  if (!m) {
    throw new Error(
      `не разобрать дату «${raw}». Ожидается «ГГГГ-ММ-ДД ЧЧ:ММ», например «2026-09-23 10:00».`,
    );
  }
  const [, y, mo, d, h, mi, s] = m;
  const naiveUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);

  // Сначала считаем смещение по первому приближению, затем уточняем:
  // это корректно обрабатывает переходы на летнее время в других поясах.
  const first = offsetMs(naiveUtc, timeZone);
  let ts = naiveUtc - first;
  const second = offsetMs(ts, timeZone);
  if (second !== first) ts = naiveUtc - second;

  const result = new Date(ts);
  if (Number.isNaN(result.getTime()))
    throw new Error(`не разобрать дату: «${raw}»`);
  return result;
}

/** Человекочитаемое время в нужном поясе: «23.09.2026 10:00». */
export function formatInZone(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hourCycle: "h23",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
