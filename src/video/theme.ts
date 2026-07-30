// Общие визуальные константы и хелперы таймлайна.

// Надёжный жирный системный шрифт — рендерится без обращения к сети.
// Хочешь брендовый? Положи .ttf в public/fonts и подключи через @remotion/google-fonts
// или loadFont из "remotion" — тогда замени эту константу.
export const FONT_FAMILY =
  '"Montserrat", "Arial Black", "Segoe UI", system-ui, sans-serif';

// Безопасная зона: отступы, за которые не заходит текст (для 1080px ширины).
export const SAFE = { x: 80, top: 100, bottom: 160 };

export const secToFrames = (sec: number, fps: number) => Math.round(sec * fps);
