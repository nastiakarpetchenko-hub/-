import React from "react";
import {
  AbsoluteFill,
  interpolate,
  Sequence,
  Easing,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { Caption } from "./types";
import { FONT_FAMILY, SAFE, secToFrames } from "./theme";

const OneCaption: React.FC<{ text: string; accent: string }> = ({
  text,
  accent,
}) => {
  const frame = useCurrentFrame(); // локальный: стартует с 0 внутри Sequence
  const { fps } = useVideoConfig();

  // Pop-in: масштаб + прозрачность на входе (всё через useCurrentFrame).
  const enter = interpolate(frame, [0, 0.25 * fps], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.34, 1.56, 0.64, 1), // лёгкий overshoot
  });
  const scale = interpolate(enter, [0, 1], [0.8, 1]);

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
          transform: `scale(${scale})`,
          opacity: enter,
          maxWidth: "90%",
          textAlign: "center",
          fontFamily: FONT_FAMILY,
          fontWeight: 900,
          fontSize: 76,
          lineHeight: 1.15,
          color: "white",
          padding: "18px 34px",
          borderRadius: 22,
          background: "rgba(0,0,0,0.55)",
          boxShadow: `0 0 0 4px ${accent}`,
          textShadow: "0 4px 18px rgba(0,0,0,0.6)",
          letterSpacing: -0.5,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

export const Captions: React.FC<{ captions: Caption[]; accent: string }> = ({
  captions,
  accent,
}) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {captions.map((c, i) => {
        const from = secToFrames(c.fromInSeconds, fps);
        const dur = secToFrames(c.toInSeconds - c.fromInSeconds, fps);
        if (dur <= 0) return null;
        return (
          <Sequence key={i} from={from} durationInFrames={dur} layout="none">
            <OneCaption text={c.text} accent={accent} />
          </Sequence>
        );
      })}
    </>
  );
};
