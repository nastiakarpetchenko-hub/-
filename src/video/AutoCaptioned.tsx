import React from "react";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
  staticFile,
} from "remotion";
import { Video } from "@remotion/media";
import {
  createTikTokStyleCaptions,
  type Caption,
} from "@remotion/captions";
import { FONT_FAMILY, SAFE } from "./theme";

// ─── Пропсы композиции (их присылает бот на рендер) ──────────────────
export type AutoCaptionedProps = {
  /** http-URL (бот раздаёт локально) или имя файла в public/. Пусто → заглушка. */
  videoSrc: string;
  /** Длина итогового видео. Используется в calculateMetadata (Root.tsx). */
  durationInSeconds: number;
  /** Субтитры в формате @remotion/captions (из Whisper). */
  captions: Caption[];
  /** Заголовок-плашка в начале (motion). Пусто — не показывать. */
  title: string;
  accentColor: string;
  /** Плашка «Подпишись» в конце. */
  showSubscribeOutro: boolean;
};

export const autoCaptionedDefaults: AutoCaptionedProps = {
  videoSrc: "",
  durationInSeconds: 12,
  captions: [
    { text: "Привет", startMs: 300, endMs: 900, timestampMs: 600, confidence: 1 },
    { text: "это", startMs: 900, endMs: 1200, timestampMs: 1050, confidence: 1 },
    { text: "автосубтитры", startMs: 1200, endMs: 2200, timestampMs: 1700, confidence: 1 },
    { text: "на", startMs: 2400, endMs: 2650, timestampMs: 2500, confidence: 1 },
    { text: "русском!", startMs: 2650, endMs: 3400, timestampMs: 3000, confidence: 1 },
  ],
  title: "АВТОСУБТИТРЫ 🎬",
  accentColor: "#FFD84D",
  showSubscribeOutro: true,
};

const resolveSrc = (src: string) =>
  /^https?:\/\//.test(src) ? src : staticFile(src);

// ─── Фон: видео (cover-кроп в вертикаль) или градиент-заглушка ────────
const Background: React.FC<{ src: string }> = ({ src }) => {
  if (!src) {
    return (
      <AbsoluteFill
        style={{ background: "linear-gradient(140deg,#1e3a8a,#0f172a)" }}
      />
    );
  }
  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Video
        src={resolveSrc(src)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};

// ─── Верхний прогресс-бар (motion, показывает ход ролика) ─────────────
const ProgressBar: React.FC<{ accent: string }> = ({ accent }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const w = interpolate(frame, [0, durationInFrames], [0, 100], {
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-start" }}>
      <div style={{ height: 8, width: `${w}%`, backgroundColor: accent }} />
    </AbsoluteFill>
  );
};

// ─── Всплывающая плашка (motion-дизайн): pop-in по spring ─────────────
const Plaque: React.FC<{
  children: React.ReactNode;
  accent: string;
  align: "top" | "bottom";
}> = ({ children, accent, align }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame, fps, config: { damping: 12, mass: 0.6 } });
  const y = interpolate(s, [0, 1], [align === "top" ? -60 : 60, 0]);
  return (
    <AbsoluteFill
      style={{
        justifyContent: align === "top" ? "flex-start" : "flex-end",
        alignItems: "center",
        paddingTop: align === "top" ? SAFE.top + 30 : 0,
        paddingBottom: align === "bottom" ? SAFE.bottom + 40 : 0,
      }}
    >
      <div
        style={{
          transform: `translateY(${y}px) scale(${s})`,
          opacity: s,
          fontFamily: FONT_FAMILY,
          fontWeight: 900,
          fontSize: 60,
          color: "#0b0b0b",
          background: accent,
          padding: "16px 40px",
          borderRadius: 999,
          boxShadow: "0 12px 40px rgba(0,0,0,0.45)",
          letterSpacing: -0.5,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

// ─── Одна «страница» субтитров с подсветкой активного слова ──────────
const CaptionPage: React.FC<{
  tokens: { text: string; fromMs: number; toMs: number }[];
  accent: string;
  startMs: number;
}> = ({ tokens, accent, startMs }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const enter = spring({ frame, fps, config: { damping: 200 }, durationInFrames: 6 });
  const nowMs = startMs + (frame / fps) * 1000;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: SAFE.bottom,
        paddingLeft: SAFE.x,
        paddingRight: SAFE.x,
      }}
    >
      <div
        style={{
          transform: `scale(${interpolate(enter, [0, 1], [0.86, 1])})`,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "12px 16px",
          maxWidth: "92%",
          textAlign: "center",
          fontFamily: FONT_FAMILY,
          fontWeight: 900,
          fontSize: 74,
          lineHeight: 1.1,
        }}
      >
        {tokens.map((tok, i) => {
          const active = nowMs >= tok.fromMs && nowMs <= tok.toMs;
          return (
            <span
              key={i}
              style={{
                color: active ? "#0b0b0b" : "white",
                background: active ? accent : "rgba(0,0,0,0.55)",
                padding: "6px 16px",
                borderRadius: 14,
                textShadow: active ? "none" : "0 3px 12px rgba(0,0,0,0.6)",
                transform: active ? "translateY(-4px)" : "none",
                display: "inline-block",
              }}
            >
              {tok.text}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

// ─── Главная композиция ──────────────────────────────────────────────
export const AutoCaptioned: React.FC<AutoCaptionedProps> = ({
  videoSrc,
  captions,
  title,
  accentColor,
  showSubscribeOutro,
}) => {
  const { fps, durationInFrames } = useVideoConfig();

  const { pages } = createTikTokStyleCaptions({
    captions,
    combineTokensWithinMilliseconds: 1200,
  });

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Background src={videoSrc} />

      <ProgressBar accent={accentColor} />

      {/* Субтитры постранично, тайминг из Whisper */}
      {pages.map((page, i) => {
        const from = Math.round((page.startMs / 1000) * fps);
        const durMs =
          (page.tokens[page.tokens.length - 1]?.toMs ?? page.startMs) -
          page.startMs;
        const dur = Math.max(fps / 2, Math.round((durMs / 1000) * fps));
        return (
          <Sequence key={i} from={from} durationInFrames={dur} layout="none">
            <CaptionPage
              tokens={page.tokens}
              accent={accentColor}
              startMs={page.startMs}
            />
          </Sequence>
        );
      })}

      {/* Motion-плашка заголовка в начале (первые ~2.5с) */}
      {title ? (
        <Sequence durationInFrames={Math.round(2.5 * fps)} layout="none">
          <Plaque accent={accentColor} align="top">
            {title}
          </Plaque>
        </Sequence>
      ) : null}

      {/* Плашка «Подпишись» в конце (последние ~3с) */}
      {showSubscribeOutro ? (
        <Sequence
          from={Math.max(0, durationInFrames - Math.round(3 * fps))}
          durationInFrames={Math.round(3 * fps)}
          layout="none"
        >
          <Plaque accent={accentColor} align="bottom">
            Подпишись 🔔
          </Plaque>
        </Sequence>
      ) : null}
    </AbsoluteFill>
  );
};
