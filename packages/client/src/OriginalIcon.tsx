import React from "react";
import { gameFrames } from "./original-art.generated.js";
export type OriginalIconName = keyof typeof gameFrames;
export function OriginalIcon({
  name,
  size = 18,
}: {
  name: OriginalIconName;
  size?: number;
}) {
  const frame = gameFrames[name];
  const scale = size / Math.max(frame.w, frame.h);
  return (
    <span
      className="original-icon"
      aria-hidden="true"
      style={{
        width: frame.w * scale,
        height: frame.h * scale,
        maskImage: "url(/assets/original/GameElements-Qt-7shUI.png)",
        maskSize: `${1024 * scale}px ${2048 * scale}px`,
        maskPosition: `${-frame.x * scale}px ${-frame.y * scale}px`,
      }}
    />
  );
}
const icon = (name: OriginalIconName) =>
  function AtlasIcon({ size = 18 }: { size?: number }) {
    return <OriginalIcon name={name} size={size} />;
  };
export const Gear = icon("Gear");
export const X = icon("X");
export const Check = icon("Check");
export const MessageCircle = icon("CommButton");
export const Clock3 = icon("TimeMachineButton");
export const Timer = icon("TimeMachineButton");
export const Factory = icon("SmallFactory");
export const Zap = icon("SmallGenerator");
export const Gem = icon("SmallMine");
export const LockKeyhole = icon("Locked");
export const RotateCcw = icon("Restart");
