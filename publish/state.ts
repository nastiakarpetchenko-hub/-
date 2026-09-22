import fs from "node:fs";
import path from "node:path";
import { publishConfig } from "./config";
import type { PlatformId, PublishResult } from "./types";

// Журнал публикаций: что и куда уже ушло.
// Главная задача — идемпотентность: один и тот же пост не должен уйти дважды,
// даже если сервер перезапустился ровно в момент публикации.

export type EntryStatus = "published" | "failed" | "skipped";

export interface StateEntry {
  status: EntryStatus;
  /** Когда зафиксировали результат (UTC, ISO). */
  at: string;
  attempts: number;
  remoteId?: string;
  url?: string;
  error?: string;
}

export interface PublishState {
  version: 1;
  /** postId → площадка → результат. */
  posts: Record<string, Partial<Record<PlatformId, StateEntry>>>;
}

const EMPTY: PublishState = { version: 1, posts: {} };

export function loadState(file = publishConfig.stateFile): PublishState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as PublishState;
    if (!parsed || typeof parsed !== "object" || !parsed.posts)
      return { ...EMPTY };
    return { version: 1, posts: parsed.posts };
  } catch {
    // Файла ещё нет (первый запуск) или он повреждён — начинаем с чистого.
    return { ...EMPTY, posts: {} };
  }
}

export function saveState(
  state: PublishState,
  file = publishConfig.stateFile,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Пишем через временный файл: при падении посреди записи журнал не потеряется.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

export function getEntry(
  state: PublishState,
  postId: string,
  platform: PlatformId,
): StateEntry | undefined {
  return state.posts[postId]?.[platform];
}

/** Уже опубликовано — повторять нельзя. */
export function isPublished(
  state: PublishState,
  postId: string,
  platform: PlatformId,
): boolean {
  return getEntry(state, postId, platform)?.status === "published";
}

/** Исчерпаны ли попытки после серии ошибок. */
export function isExhausted(
  state: PublishState,
  postId: string,
  platform: PlatformId,
  maxAttempts = publishConfig.maxAttempts,
): boolean {
  const entry = getEntry(state, postId, platform);
  return (
    !!entry && entry.status !== "published" && entry.attempts >= maxAttempts
  );
}

export function recordResult(
  state: PublishState,
  postId: string,
  platform: PlatformId,
  result: PublishResult,
): StateEntry {
  const prev = getEntry(state, postId, platform);
  const entry: StateEntry = {
    status: result.ok ? "published" : "failed",
    at: new Date().toISOString(),
    attempts: (prev?.attempts ?? 0) + 1,
    remoteId: result.remoteId,
    url: result.url,
    error: result.ok ? undefined : result.error,
  };
  state.posts[postId] = { ...state.posts[postId], [platform]: entry };
  return entry;
}

/** Пометить как пропущенное (например, пост «просрочен» и публиковать поздно). */
export function recordSkipped(
  state: PublishState,
  postId: string,
  platform: PlatformId,
  reason: string,
): void {
  const prev = getEntry(state, postId, platform);
  state.posts[postId] = {
    ...state.posts[postId],
    [platform]: {
      status: "skipped",
      at: new Date().toISOString(),
      attempts: prev?.attempts ?? 0,
      error: reason,
    },
  };
}
