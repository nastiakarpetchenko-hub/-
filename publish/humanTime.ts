import { parsePlanTime } from "./tz";

// Человеческое время: «завтра в 10:00», «через 2 часа», «23.09 18:30».
// Нужно, чтобы в Telegram можно было назначить публикацию словами,
// а не форматом ГГГГ-ММ-ДД ЧЧ:ММ.

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Календарные части момента времени в нужном поясе. */
export function localParts(date: Date, timeZone: string): Parts {
  const p: Record<string, number> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  for (const { type, value } of fmt.formatToParts(date)) {
    if (type !== "literal") p[type] = Number(value);
  }
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Строка для контент-плана: «2026-09-23 10:00». */
export function planString(parts: Parts): string {
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

/** Время публикации в том виде, в каком оно пишется в план. */
export function formatPlanTime(date: Date, timeZone: string): string {
  return planString(localParts(date, timeZone));
}

/** Сдвиг на несколько дней по календарю (не по 24 часам — это разные вещи). */
function shiftDays(parts: Parts, days: number): Parts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: parts.hour,
    minute: parts.minute,
  };
}

const TIME_RE = /(\d{1,2})[:.](\d{2})/;

/**
 * Разбирает время, написанное человеком. Вернёт null, если не понял.
 * Понимает: «сейчас», «через 2 часа», «сегодня 19:00», «завтра в 10:00»,
 * «послезавтра 9:00», «23.09 18:30», «23.09.2026 18:30», «10:00»,
 * «2026-09-23 10:00».
 */
export function parseHumanTime(
  input: string,
  timeZone: string,
  now = new Date(),
): Date | null {
  const raw = input.trim().toLowerCase().replace(/\s+/g, " ");
  if (!raw) return null;

  if (raw === "сейчас" || raw === "сразу")
    return new Date(now.getTime() + 60_000);

  // «через 20 минут», «через 2 часа», «через 3 дня»
  // \w кириллицу не ловит, поэтому диапазон пишем явно.
  const inMatch = /^через (\d+)\s*(мин[а-яё]*|час[а-яё]*|ч|д[а-яё]*)$/.exec(
    raw,
  );
  if (inMatch) {
    const n = Number(inMatch[1]);
    const unit = inMatch[2];
    const ms = unit.startsWith("мин")
      ? 60_000
      : unit.startsWith("д")
        ? 86_400_000
        : 3_600_000;
    return new Date(now.getTime() + n * ms);
  }

  // Полный формат плана — отдаём штатному разбору.
  if (/^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}/.test(raw)) {
    try {
      return parsePlanTime(raw, timeZone);
    } catch {
      return null;
    }
  }

  const today = localParts(now, timeZone);

  // «23.09 18:30» или «23.09.2026 18:30».
  // Дату ищем первой и вырезаем из строки: иначе «23.09» само сойдёт за время.
  const dateMatch = /(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?/.exec(raw);
  const looksLikeDate =
    !!dateMatch &&
    Number(dateMatch[1]) >= 1 &&
    Number(dateMatch[1]) <= 31 &&
    Number(dateMatch[2]) >= 1 &&
    Number(dateMatch[2]) <= 12;
  const time = TIME_RE.exec(
    looksLikeDate ? raw.replace(dateMatch![0], " ") : raw,
  );

  if (looksLikeDate && dateMatch && time) {
    const day = Number(dateMatch[1]);
    const month = Number(dateMatch[2]);
    let year = dateMatch[3] ? Number(dateMatch[3]) : today.year;
    if (year < 100) year += 2000;
    const parts: Parts = {
      year,
      month,
      day,
      hour: Number(time[1]),
      minute: Number(time[2]),
    };
    const date = safeParse(parts, timeZone);
    // Дата без года и уже прошла — значит, имеется в виду следующий год.
    if (date && !dateMatch[3] && date.getTime() < now.getTime()) {
      return safeParse({ ...parts, year: year + 1 }, timeZone);
    }
    return date;
  }

  if (!time) return null;
  const hm = { hour: Number(time[1]), minute: Number(time[2]) };
  if (hm.hour > 23 || hm.minute > 59) return null;

  if (raw.startsWith("завтра"))
    return safeParse({ ...shiftDays(today, 1), ...hm }, timeZone);
  if (raw.startsWith("послезавтра"))
    return safeParse({ ...shiftDays(today, 2), ...hm }, timeZone);
  if (raw.startsWith("сегодня"))
    return safeParse({ ...today, ...hm }, timeZone);

  // Просто «10:00» — ближайшее такое время: сегодня, если ещё не прошло.
  const todayAt = safeParse({ ...today, ...hm }, timeZone);
  if (todayAt && todayAt.getTime() > now.getTime()) return todayAt;
  return safeParse({ ...shiftDays(today, 1), ...hm }, timeZone);
}

function safeParse(parts: Parts, timeZone: string): Date | null {
  if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31)
    return null;
  try {
    return parsePlanTime(planString(parts), timeZone);
  } catch {
    return null;
  }
}

/** Как показать время человеку: «завтра в 10:00», «23.09 в 18:30». */
export function formatHuman(
  date: Date,
  timeZone: string,
  now = new Date(),
): string {
  const p = localParts(date, timeZone);
  const today = localParts(now, timeZone);
  const time = `${pad(p.hour)}:${pad(p.minute)}`;
  const sameDay = (a: Parts, b: Parts) =>
    a.year === b.year && a.month === b.month && a.day === b.day;

  if (sameDay(p, today)) return `сегодня в ${time}`;
  if (sameDay(p, shiftDays(today, 1))) return `завтра в ${time}`;
  if (sameDay(p, shiftDays(today, 2))) return `послезавтра в ${time}`;
  const year = p.year === today.year ? "" : `.${p.year}`;
  return `${pad(p.day)}.${pad(p.month)}${year} в ${time}`;
}

/** Быстрые варианты для кнопок: ближайшие удобные слоты. */
export function quickSlots(
  timeZone: string,
  now = new Date(),
): { label: string; date: Date }[] {
  const today = localParts(now, timeZone);
  const slots: { label: string; date: Date }[] = [
    { label: "Сейчас", date: new Date(now.getTime() + 60_000) },
    { label: "Через час", date: new Date(now.getTime() + 3_600_000) },
  ];

  // Вечерний слот сегодня — если он ещё не наступил.
  const evening = safeParse({ ...today, hour: 19, minute: 0 }, timeZone);
  if (evening && evening.getTime() > now.getTime() + 10 * 60_000) {
    slots.push({ label: "Сегодня 19:00", date: evening });
  }
  const morning = safeParse(
    { ...shiftDays(today, 1), hour: 10, minute: 0 },
    timeZone,
  );
  if (morning) slots.push({ label: "Завтра 10:00", date: morning });
  const tomorrowEvening = safeParse(
    { ...shiftDays(today, 1), hour: 19, minute: 0 },
    timeZone,
  );
  if (tomorrowEvening)
    slots.push({ label: "Завтра 19:00", date: tomorrowEvening });

  return slots;
}
