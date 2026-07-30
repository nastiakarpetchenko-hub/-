import path from "node:path";
import fs from "node:fs/promises";
import { transcribeVideo } from "./transcribe";
import { renderVideo } from "./render";
import { log } from "./logger";

export type Stage =
  | "downloaded"
  | "transcribing"
  | "rendering"
  | "done"
  | "error";

// Полный цикл обработки одного видео.
// onStage вызывается на каждом этапе — бот шлёт пользователю прогресс.
export async function processVideo(
  videoPath: string,
  jobDir: string,
  onStage: (s: Stage) => void | Promise<void>,
): Promise<string> {
  try {
    await onStage("transcribing");
    const captions = await transcribeVideo(videoPath);

    await onStage("rendering");
    const outputPath = path.join(jobDir, "result.mp4");
    await renderVideo({
      videoPath,
      captions,
      title: "", // motion-заголовок можно включить позже
      outputPath,
    });

    await onStage("done");
    return outputPath;
  } catch (e) {
    log.err(e);
    await onStage("error");
    throw e;
  } finally {
    // Чистим временные аудио/кадры, результат оставляем до отправки.
    await fs.rm(path.join(jobDir, "audio-16k.wav"), { force: true });
  }
}
