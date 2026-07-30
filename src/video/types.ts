// Типы данных для монтажа. Их использует и конфиг, и компоненты.

export type TransitionKind = "fade" | "slide-left" | "slide-up" | "wipe";

export type Clip = {
  /**
   * Имя файла в public/ (например "clips/01_intro.mp4") ИЛИ полный URL.
   * Оставь пустым ("") — вместо видео будет цветная заглушка с подписью,
   * чтобы шаблон рендерился ещё до загрузки реальных файлов.
   */
  src: string;
  /** Сколько секунд этот клип занимает в итоговом видео. */
  durationInSeconds: number;
  /** С какой секунды исходника начать (обрезка начала). По умолчанию 0. */
  trimStartInSeconds?: number;
  /** Переход ПЕРЕД этим клипом (для первого клипа игнорируется). */
  transition?: TransitionKind;
  /** Подпись-заглушка (видна только когда src пустой). */
  label?: string;
  /** Приглушить оригинальный звук клипа (0 = тишина, 1 = полный). */
  volume?: number;
};

export type Caption = {
  text: string;
  /** Время появления/исчезновения по ИТОГОВОМУ таймлайну, в секундах. */
  fromInSeconds: number;
  toInSeconds: number;
};

export type Music = {
  /** Имя файла в public/ или URL. Пусто ("") — без музыки. */
  src: string;
  /** Громкость 0..1. Под голос обычно 0.15–0.3. */
  volume: number;
};

export type MontageProps = {
  clips: Clip[];
  captions: Caption[];
  music: Music;
  /** Длительность перехода в секундах (по умолчанию 0.5). */
  transitionInSeconds: number;
  /** Акцентный цвет субтитров. */
  accentColor: string;
};
