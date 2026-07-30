import "./index.css";
import { Composition } from "remotion";
import { Montage, totalDurationInFrames } from "./video/Montage";
import { montage, FPS, WIDTH, HEIGHT } from "./video/montage.config";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="Montage"
      component={Montage}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={montage}
      // Длительность считается из конфига: сумма клипов − переходы.
      calculateMetadata={({ props }) => ({
        durationInFrames: totalDurationInFrames(props, FPS),
      })}
    />
  );
};
