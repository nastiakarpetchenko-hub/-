// ┌──────────────────────────────────────────────────────────────────┐
// │  ЕДИНСТВЕННЫЙ ФАЙЛ, КОТОРЫЙ ТЕБЕ НУЖНО РЕДАКТИРОВАТЬ.               │
// │  Впиши сюда свои клипы, субтитры и музыку — остальное соберётся.   │
// └──────────────────────────────────────────────────────────────────┘

import type { MontageProps } from "./types";

// Формат кадра. Вертикаль (Reels/Shorts/TikTok) — 1080×1920.
// Горизонталь 16:9 — 1920×1080. Квадрат 1:1 — 1080×1080.
export const FPS = 30;
export const WIDTH = 1080;
export const HEIGHT = 1920;

export const montage: MontageProps = {
  transitionInSeconds: 0.5,
  accentColor: "#FFD84D",

  // ── КЛИПЫ ─────────────────────────────────────────────────────────
  // Идут в этом порядке. src: имя файла в public/ или URL.
  // Пока src пустой ("") — рисуется цветная заглушка с label,
  // поэтому шаблон работает ещё до загрузки твоих видео.
  clips: [
    {
      src: "", // напр. "clips/01_intro.mp4"
      label: "Клип 1 · Хук",
      durationInSeconds: 3,
      // trimStartInSeconds: 2, // взять исходник с 2-й секунды
      transition: "fade", // переход перед клипом (у первого не применяется)
      volume: 1,
    },
    {
      src: "",
      label: "Клип 2 · Основа",
      durationInSeconds: 4,
      transition: "slide-left",
      volume: 1,
    },
    {
      src: "",
      label: "Клип 3 · Детали",
      durationInSeconds: 4,
      transition: "slide-up",
      volume: 1,
    },
    {
      src: "",
      label: "Клип 4 · Финал / CTA",
      durationInSeconds: 3,
      transition: "wipe",
      volume: 1,
    },
  ],

  // ── СУБТИТРЫ ──────────────────────────────────────────────────────
  // Время — по ИТОГОВОМУ таймлайну (после вычета переходов).
  // Можно оставить пустым []: субтитры я сгенерирую автоматически из речи.
  captions: [
    { text: "Смотри до конца 👀", fromInSeconds: 0.2, toInSeconds: 2.8 },
    { text: "Вот в чём суть", fromInSeconds: 3.0, toInSeconds: 6.5 },
    { text: "Важная деталь", fromInSeconds: 6.8, toInSeconds: 10.5 },
    { text: "Подпишись 🔥", fromInSeconds: 10.8, toInSeconds: 12.5 },
  ],

  // ── ФОНОВАЯ МУЗЫКА ────────────────────────────────────────────────
  music: {
    src: "", // напр. "audio/track.mp3"
    volume: 0.22, // приглушено под голос; 0 или пустой src — без музыки
  },
};
