import path from "node:path";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { Caption } from "@remotion/captions";
import {
  installWhisperCpp,
  downloadWhisperModel,
  transcribe,
  toCaptions,
  type WhisperModel,
} from "@remotion/install-whisper-cpp";
import { config } from "./config";
import { log } from "./logger";

// Конвертация видео/аудио в WAV 16кГц моно (это нужно whisper.cpp).
// Используем ffmpeg, встроенный в Remotion (отдельная установка не требуется).
function toWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      "npx",
      [
        "remotion",
        "ffmpeg",
        "-y",
        "-i",
        input,
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        output,
      ],
      { stdio: "ignore" },
    );
    p.on("error", reject);
    p.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)),
    );
  });
}

let whisperReady: Promise<void> | null = null;

// Установка whisper.cpp и модели выполняется один раз (github разрешён).
function ensureWhisper(): Promise<void> {
  if (!whisperReady) {
    whisperReady = (async () => {
      log.info("Готовлю whisper.cpp…");
      await installWhisperCpp({
        to: config.whisper.installDir,
        version: config.whisper.version,
      });
      await downloadWhisperModel({
        model: config.whisper.model as WhisperModel,
        folder: config.whisper.installDir,
      });
      log.ok(`whisper.cpp готов, модель: ${config.whisper.model}`);
    })();
  }
  return whisperReady;
}

// Локальное распознавание через whisper.cpp.
async function transcribeLocal(videoPath: string): Promise<Caption[]> {
  await ensureWhisper();
  const wav = path.join(path.dirname(videoPath), "audio-16k.wav");
  await toWav(videoPath, wav);

  const whisperOutput = await transcribe({
    inputPath: wav,
    whisperPath: config.whisper.installDir,
    whisperCppVersion: config.whisper.version,
    model: config.whisper.model as WhisperModel,
    language: config.whisper
      .language as Parameters<typeof transcribe>[0]["language"],
    tokenLevelTimestamps: true,
    printOutput: false,
  });

  await fs.rm(wav, { force: true });
  const { captions } = toCaptions({ whisperCppOutput: whisperOutput });
  return captions;
}

// Облачное распознавание через OpenAI Whisper API (подключим позже по ключу).
async function transcribeOpenAI(videoPath: string): Promise<Caption[]> {
  if (!config.openaiApiKey) {
    throw new Error("SUBTITLE_ENGINE=openai, но OPENAI_API_KEY не задан.");
  }
  const wav = path.join(path.dirname(videoPath), "audio-16k.wav");
  await toWav(videoPath, wav);

  const form = new FormData();
  const buf = await fs.readFile(wav);
  form.append("file", new Blob([buf]), "audio.wav");
  form.append("model", "whisper-1");
  form.append("language", config.whisper.language);
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiApiKey}` },
    body: form,
  });
  await fs.rm(wav, { force: true });
  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    words?: { word: string; start: number; end: number }[];
  };
  return (data.words ?? []).map((w) => ({
    text: w.word,
    startMs: Math.round(w.start * 1000),
    endMs: Math.round(w.end * 1000),
    timestampMs: Math.round(((w.start + w.end) / 2) * 1000),
    confidence: 1,
  }));
}

export async function transcribeVideo(videoPath: string): Promise<Caption[]> {
  const captions =
    config.subtitleEngine === "openai"
      ? await transcribeOpenAI(videoPath)
      : await transcribeLocal(videoPath);
  log.ok(`Распознано слов: ${captions.length}`);
  return captions;
}
