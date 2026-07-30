import React from "react";
import { AbsoluteFill, staticFile, useVideoConfig } from "remotion";
import { Video } from "@remotion/media";
import type { Clip as ClipData } from "./types";
import { FONT_FAMILY } from "./theme";

// Определяем: это URL или локальный файл в public/?
const resolveSrc = (src: string) =>
  /^https?:\/\//.test(src) ? src : staticFile(src);

const FALLBACK_COLORS = [
  ["#1e3a8a", "#0f172a"],
  ["#7c2d12", "#1c1917"],
  ["#134e4a", "#0f172a"],
  ["#4c1d95", "#1e1b4b"],
];

export const Clip: React.FC<{ clip: ClipData; index: number }> = ({
  clip,
  index,
}) => {
  const { fps } = useVideoConfig();

  // Нет файла → цветная заглушка, чтобы монтаж рендерился без ассетов.
  if (!clip.src) {
    const [a, b] = FALLBACK_COLORS[index % FALLBACK_COLORS.length];
    return (
      <AbsoluteFill
        style={{
          background: `linear-gradient(140deg, ${a}, ${b})`,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div
          style={{
            fontFamily: FONT_FAMILY,
            color: "rgba(255,255,255,0.85)",
            fontSize: 56,
            fontWeight: 800,
            textAlign: "center",
            padding: "0 80px",
          }}
        >
          {clip.label ?? `Клип ${index + 1}`}
        </div>
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      <Video
        src={resolveSrc(clip.src)}
        trimBefore={Math.round((clip.trimStartInSeconds ?? 0) * fps)}
        volume={clip.volume ?? 1}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};
