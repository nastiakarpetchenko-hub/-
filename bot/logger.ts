// Простой логгер с временными метками.
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

export const log = {
  info: (...a: unknown[]) => console.log(`[${ts()}] ℹ`, ...a),
  ok: (...a: unknown[]) => console.log(`[${ts()}] ✓`, ...a),
  warn: (...a: unknown[]) => console.warn(`[${ts()}] ⚠`, ...a),
  err: (...a: unknown[]) => console.error(`[${ts()}] ✗`, ...a),
};
