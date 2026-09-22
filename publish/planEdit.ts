import fs from "node:fs";
import path from "node:path";
import YAML, { Scalar, YAMLMap, YAMLSeq } from "yaml";
import { publishConfig } from "./config";
import { loadPlan } from "./plan";
import { formatPlanTime } from "./humanTime";
import { isPublished, loadState } from "./state";
import type { PlannedPost, PlatformId, PostType } from "./types";

// Запись в контент-план из кода (бот добавляет и удаляет посты).
// Правим не текстом, а YAML-документом: комментарии и ручные правки
// человека остаются на месте.

const HEADER = `# Контент-план. Посты сюда добавляет Telegram-бот,
# но файл остаётся обычным текстом — можно править руками.
# Проверить: npm run publish:check

`;

export interface NewPost {
  id?: string;
  when: Date;
  type: PostType;
  platforms: PlatformId[];
  /** Пути относительно content/ (как в плане). */
  media: string[];
  cover?: string;
  text: string;
  tags?: string[];
}

function readDocument(): YAML.Document.Parsed {
  const file = publishConfig.planFile;
  if (!fs.existsSync(file)) {
    return YAML.parseDocument(
      `${HEADER}timezone: ${publishConfig.timezone}\nposts: []\n`,
    );
  }
  return YAML.parseDocument(fs.readFileSync(file, "utf8"));
}

function writeDocument(doc: YAML.Document): void {
  const file = publishConfig.planFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, doc.toString({ lineWidth: 0 }), "utf8");
  fs.renameSync(tmp, file);
}

/** Список постов документа: поддерживаем и «posts:», и просто список. */
function postsSeq(doc: YAML.Document): YAMLSeq {
  if (YAML.isSeq(doc.contents)) return doc.contents;
  const existing = doc.get("posts");
  if (YAML.isSeq(existing)) return existing;
  const seq = new YAMLSeq();
  doc.set("posts", seq);
  return seq;
}

/** Уникальный id вида «2026-09-23-1000-reel» (при совпадении добавляем суффикс). */
export function makePostId(
  type: PostType,
  when: Date,
  existing: Set<string>,
): string {
  const stamp = formatPlanTime(when, publishConfig.timezone)
    .replace(/[: ]/g, "-")
    .replace(/-(\d{2})-(\d{2})$/, "-$1$2");
  const base = `${stamp}-${type}`;
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/** Добавляет пост в конец плана. Возвращает его id. */
export function appendPost(input: NewPost): string {
  const doc = readDocument();
  const seq = postsSeq(doc);

  const taken = new Set<string>();
  for (const item of seq.items) {
    if (YAML.isMap(item)) {
      const id = item.get("id");
      if (typeof id === "string") taken.add(id);
    }
  }

  const id =
    input.id && !taken.has(input.id)
      ? input.id
      : makePostId(input.type, input.when, taken);

  const node = doc.createNode({
    id,
    when: formatPlanTime(input.when, publishConfig.timezone),
    type: input.type,
    platforms: input.platforms,
    media: input.media,
    ...(input.cover ? { cover: input.cover } : {}),
    text: input.text,
    ...(input.tags?.length ? { tags: input.tags } : {}),
  }) as YAMLMap;

  // Текст поста пишем блоком — так его удобно читать и править руками.
  const textNode = node.get("text", true);
  if (
    textNode instanceof Scalar &&
    typeof textNode.value === "string" &&
    textNode.value.includes("\n")
  ) {
    textNode.type = Scalar.BLOCK_LITERAL;
  }

  seq.add(node);
  writeDocument(doc);
  return id;
}

/** Удаляет пост из плана. false — если такого id там нет. */
export function removePost(id: string): boolean {
  const doc = readDocument();
  const seq = postsSeq(doc);
  const index = seq.items.findIndex(
    (item) => YAML.isMap(item) && item.get("id") === id,
  );
  if (index < 0) return false;
  seq.delete(index);
  writeDocument(doc);
  return true;
}

export interface UpcomingPost {
  post: PlannedPost;
  /** Хотя бы одна площадка уже опубликована — пост трогать поздно. */
  started: boolean;
}

/** Ближайшие запланированные посты (те, что ещё не вышли). */
export function upcoming(limit = 10, now = new Date()): UpcomingPost[] {
  const { posts } = loadPlan();
  const state = loadState();
  return posts
    .filter(
      (post) => !post.platforms.every((p) => isPublished(state, post.id, p)),
    )
    .filter((post) => post.when.getTime() > now.getTime() - 60 * 60 * 1000)
    .slice(0, limit)
    .map((post) => ({
      post,
      started: post.platforms.some((p) => isPublished(state, post.id, p)),
    }));
}
