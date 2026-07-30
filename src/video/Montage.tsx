import React from "react";
import {
  AbsoluteFill,
  interpolate,
  staticFile,
  useVideoConfig,
} from "remotion";
import { Audio } from "@remotion/media";
import {
  TransitionSeries,
  linearTiming,
  type TransitionPresentation,
} from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import type { MontageProps, TransitionKind } from "./types";
import { Clip } from "./Clip";
import { Captions } from "./Captions";
import { secToFrames } from "./theme";

// Итоговая длина = сумма клипов − сумма переходов (переходы «съедают» время).
export const totalDurationInFrames = (
  props: MontageProps,
  fps: number,
): number => {
  const clipFrames = props.clips.reduce(
    (sum, c) => sum + secToFrames(c.durationInSeconds, fps),
    0,
  );
  const tFrames = secToFrames(props.transitionInSeconds, fps);
  const nTransitions = Math.max(0, props.clips.length - 1);
  return Math.max(1, clipFrames - nTransitions * tFrames);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const presentationFor = (
  kind: TransitionKind = "fade",
): TransitionPresentation<any> => {
  switch (kind) {
    case "slide-left":
      return slide({ direction: "from-right" });
    case "slide-up":
      return slide({ direction: "from-bottom" });
    case "wipe":
      return wipe({ direction: "from-right" });
    case "fade":
    default:
      return fade();
  }
};

const resolveSrc = (src: string) =>
  /^https?:\/\//.test(src) ? src : staticFile(src);

export const Montage: React.FC<MontageProps> = (props) => {
  const { fps } = useVideoConfig();
  const { clips, captions, music, accentColor } = props;
  const tFrames = secToFrames(props.transitionInSeconds, fps);
  const total = totalDurationInFrames(props, fps);

  // Плавный fade in/out музыки (0.8с) поверх её базовой громкости.
  const musicVolume = (f: number) => {
    const fadeF = Math.round(0.8 * fps);
    const env = interpolate(
      f,
      [0, fadeF, total - fadeF, total],
      [0, 1, 1, 0],
      { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
    );
    return env * music.volume;
  };

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {/* 1. Видеоряд с переходами */}
      <TransitionSeries>
        {clips.map((clip, i) => {
          const durF = secToFrames(clip.durationInSeconds, fps);
          return (
            <React.Fragment key={i}>
              {i > 0 && (
                <TransitionSeries.Transition
                  presentation={presentationFor(clip.transition)}
                  timing={linearTiming({ durationInFrames: tFrames })}
                />
              )}
              <TransitionSeries.Sequence durationInFrames={durF} premountFor={fps}>
                <Clip clip={clip} index={i} />
              </TransitionSeries.Sequence>
            </React.Fragment>
          );
        })}
      </TransitionSeries>

      {/* 2. Субтитры поверх видео (тайминг по итоговому таймлайну) */}
      <Captions captions={captions} accent={accentColor} />

      {/* 3. Фоновая музыка с fade in/out */}
      {music.src ? (
        <Audio src={resolveSrc(music.src)} volume={musicVolume} loop />
      ) : null}
    </AbsoluteFill>
  );
};
