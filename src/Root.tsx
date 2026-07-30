import "./index.css";
import { Composition } from "remotion";
import { Montage, totalDurationInFrames } from "./video/Montage";
import { montage, FPS, WIDTH, HEIGHT } from "./video/montage.config";
import {
  AutoCaptioned,
  autoCaptionedDefaults,
} from "./video/AutoCaptioned";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      {/* Ручной монтаж из нескольких клипов */}
      <Composition
        id="Montage"
        component={Montage}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={montage}
        calculateMetadata={({ props }) => ({
          durationInFrames: totalDurationInFrames(props, FPS),
        })}
      />

      {/* Авто-субтитры для одного видео (использует Telegram-бот) */}
      <Composition
        id="AutoCaptioned"
        component={AutoCaptioned}
        fps={FPS}
        width={WIDTH}
        height={HEIGHT}
        defaultProps={autoCaptionedDefaults}
        calculateMetadata={({ props }) => ({
          durationInFrames: Math.max(
            1,
            Math.ceil(props.durationInSeconds * FPS),
          ),
        })}
      />
    </>
  );
};
