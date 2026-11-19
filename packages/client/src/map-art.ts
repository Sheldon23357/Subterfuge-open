import { mapCountFont } from "./typography.js";
import { gameFrames } from "./original-art.generated.js";
const base = "/assets/original/";
const load = (name: string) => {
  const image = new Image();
  image.src = base + name;
  return image;
};
const atlas = load("GameElements-Qt-7shUI.png");

const sea = load("Sea-8Q-aXb55.png");
type Frame = { x: number; y: number; w: number; h: number };
const cache = new Map<string, HTMLCanvasElement>();
function sprite(image: HTMLImageElement, frame: Frame, color: string) {
  if (!image.complete || !image.naturalWidth) return null;
  const key = `${image.src}:${frame.x}:${frame.y}:${color}`;
  let tile = cache.get(key);
  if (!tile) {
    tile = document.createElement("canvas");
    tile.width = frame.w;
    tile.height = frame.h;
    const c = tile.getContext("2d")!;
    c.drawImage(
      image,
      frame.x,
      frame.y,
      frame.w,
      frame.h,
      0,
      0,
      frame.w,
      frame.h,
    );
    c.globalCompositeOperation = "source-in";
    c.fillStyle = color;
    c.fillRect(0, 0, frame.w, frame.h);
    cache.set(key, tile);
  }
  return tile;
}
function draw(
  ctx: CanvasRenderingContext2D,
  name: keyof typeof gameFrames,
  size: number,
  color: string,
) {
  const tile = sprite(atlas, gameFrames[name], color);
  if (tile) ctx.drawImage(tile, -size / 2, -size / 2, size, size);
}
export function drawStation(
  ctx: CanvasRenderingContext2D,
  type: string,
  color: string,
  shield: number,
  max: number,
  active = true,
) {
  ctx.save();
  // Keep the pointer target generous while reducing the visible station footprint.
  ctx.scale(0.7225, 0.7225);
  const ring = Math.min(40, Math.max(10, Math.ceil(max / 10) * 10));
  if (max > 0) {
    ctx.globalAlpha = 0.28;
    draw(ctx, `Shields${ring}e` as keyof typeof gameFrames, 70, "#a6aaa4");
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(
      0,
      0,
      38,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * Math.max(0, Math.min(1, shield / max)),
    );
    ctx.closePath();
    ctx.save();
    ctx.clip();
    draw(ctx, `Shields${ring}` as keyof typeof gameFrames, 70, "#b6b9b2");
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  const name =
    type === "mine" ? "Mine" : type === "factory" ? "Factory" : "Generator";
  draw(ctx, active ? `${name}Fill` : `${name}Outline`, 42, color);
  if (name === "Generator") draw(ctx, "GeneratorDots", 42, "#eef3ef");
  else {
    const f = gameFrames[name === "Mine" ? "MineDots" : "FactoryDots"];
    const tile = sprite(atlas, f, "#eef3ef");
    if (tile) {
      const width = name === "Mine" ? 3 : 34,
        height = name === "Mine" ? 27 : 3;
      ctx.drawImage(
        tile,
        -width / 2,
        name === "Mine" ? -14 : 23,
        width,
        height,
      );
    }
  }
  ctx.restore();
}
export function drawSubmarine(
  ctx: CanvasRenderingContext2D,
  color: string,
  angle: number,
  count?: number,
  tint?: { color: string; amount: number },
) {
  ctx.save();
  ctx.rotate(angle);
  const outline = sprite(atlas, gameFrames.SubIcon, "#ffffff");
  if (outline) {
    // Follow the sprite silhouette with a thin outline in screen pixels.
    for (let i = 0; i < 8; i++) {
      const direction = (i * Math.PI) / 4;
      ctx.drawImage(
        outline,
        -25 + Math.cos(direction) * 0.75,
        -25 + Math.sin(direction) * 0.75,
        50,
        50,
      );
    }
  }
  draw(ctx, "SubIcon", 50, color);
  if (tint) {
    ctx.save();
    ctx.globalAlpha *= tint.amount;
    draw(ctx, "SubIcon", 50, tint.color);
    ctx.restore();
  }
  if (count !== undefined) {
    // The atlas hull is slightly below/right of its square frame's center.
    ctx.translate(2.5, 3);
    ctx.rotate(-angle);
    ctx.fillStyle = "#10202a";
    ctx.font = mapCountFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const text=String(count),metrics=ctx.measureText(text);
    ctx.fillText(text,0,(metrics.actualBoundingBoxAscent-metrics.actualBoundingBoxDescent)/2);
  }
  ctx.restore();
}
// Lucide Gift geometry, drawn directly on the map canvas.
let giftOutline: Path2D | undefined;
export function drawGift(ctx: CanvasRenderingContext2D, x: number, y: number, color: string) {
  giftOutline ??= new Path2D(
    "M4 8h16a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z " +
    "M12 8v13 M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7 " +
    "M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5",
  );
  ctx.save();
  ctx.translate(x - 8, y - 8);
  ctx.scale(16 / 24, 16 / 24);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(giftOutline);
  ctx.restore();
}
let seaTile: HTMLCanvasElement | null = null;
export function drawSea(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cx: number,
  cy: number,
  scale: number,
  grid: boolean,
) {
  ctx.fillStyle = "#1b2c35";
  ctx.fillRect(0, 0, w, h);
  if (!seaTile && sea.complete && sea.naturalWidth) {
    seaTile = document.createElement("canvas");
    seaTile.width = seaTile.height = 2048;
    const c = seaTile.getContext("2d")!;
    c.drawImage(sea, 0, 0);
    c.globalCompositeOperation = "multiply";
    c.fillStyle = "#7baac2";
    c.fillRect(0, 0, 2048, 2048);
  }
  const tileSize = 64 * scale;
  if (seaTile) {
    const pattern = ctx.createPattern(seaTile, "repeat")!;
    pattern.setTransform(
      new DOMMatrix().translate(cx, cy).scale(tileSize / 2048),
    );
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
  }
  if (grid) {
    const spacing = 6 * scale;
    ctx.strokeStyle = "#8e86ad66";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = ((cx % spacing) + spacing) % spacing; x < w; x += spacing)
      for (let y = ((cy % spacing) + spacing) % spacing; y < h; y += spacing) {
        ctx.moveTo(x - 4, y);
        ctx.lineTo(x + 4, y);
        ctx.moveTo(x, y - 4);
        ctx.lineTo(x, y + 4);
      }
    ctx.stroke();
  }
}

/** Original atlas badges for state overlays; no gameplay state is inferred here. */
export function drawMapBadge(
  ctx: CanvasRenderingContext2D,
  name: keyof typeof gameFrames,
  x: number,
  y: number,
  size: number,
  color = "#81cffa",
) {
  ctx.save();
  ctx.translate(x, y);
  draw(ctx, name, size, color);
  ctx.restore();
}
