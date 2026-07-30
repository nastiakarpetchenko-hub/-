import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { bundle } from "@remotion/bundler";
import { renderMedia, selectComposition } from "@remotion/renderer";
import type { Caption } from "@remotion/captions";
import { config } from "./config";
import { log } from "./logger";

// ── Локальный статик-сервер: Remotion читает загруженное видео по http ──
// (обращение к 127.0.0.1 идёт мимо прокси, поэтому работает в любой среде).
let staticServerStarted = false;
function ensureStaticServer(): void {
  if (staticServerStarted) return;
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const filePath = path.join(config.workDir, rel);
    if (!filePath.startsWith(config.workDir) || !fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "video/mp4" });
    fs.createReadStream(filePath).pipe(res);
  });
  server.listen(config.staticPort, "127.0.0.1");
  staticServerStarted = true;
  log.ok(`Статик-сервер на http://127.0.0.1:${config.staticPort}`);
}

// ── Бандл Remotion собирается один раз и переиспользуется ──────────────
let bundlePromise: Promise<string> | null = null;
function ensureBundle(): Promise<string> {
  if (!bundlePromise) {
    log.info("Собираю бандл Remotion…");
    bundlePromise = bundle({
      entryPoint: path.resolve("src/index.ts"),
      // tailwind включён в remotion.config.ts, отдельно настраивать не нужно.
    }).then((url) => {
      log.ok("Бандл Remotion готов");
      return url;
    });
  }
  return bundlePromise;
}

// ── Длительность видео через ffprobe (встроен в Remotion) ──────────────
function probeDurationSec(input: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const p = spawn("npx", [
      "remotion",
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      input,
    ]);
    p.stdout.on("data", (c) => chunks.push(c));
    p.on("error", reject);
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}`));
      resolve(parseFloat(Buffer.concat(chunks).toString().trim()) || 0);
    });
  });
}

export type RenderArgs = {
  /** Абсолютный путь к загруженному видео (внутри workDir). */
  videoPath: string;
  captions: Caption[];
  title?: string;
  outputPath: string;
};

export async function renderVideo(args: RenderArgs): Promise<string> {
  ensureStaticServer();
  const serveUrl = await ensureBundle();

  const rawDuration = await probeDurationSec(args.videoPath);
  const durationInSeconds = Math.min(
    rawDuration || config.maxDurationSec,
    config.maxDurationSec,
  );

  // http-ссылка на видео для Remotion.
  const rel = path
    .relative(config.workDir, args.videoPath)
    .split(path.sep)
    .join("/");
  const videoSrc = `http://127.0.0.1:${config.staticPort}/${rel}`;

  const inputProps = {
    videoSrc,
    durationInSeconds,
    captions: args.captions,
    title: args.title ?? "",
    accentColor: config.accentColor,
    showSubscribeOutro: true,
  };

  const composition = await selectComposition({
    serveUrl,
    id: "AutoCaptioned",
    inputProps,
  });

  log.info(`Рендер ${composition.durationInFrames} кадров…`);
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: args.outputPath,
    inputProps,
    concurrency: config.renderConcurrency,
    browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE || undefined,
  });
  log.ok(`Готово: ${args.outputPath}`);
  return args.outputPath;
}
