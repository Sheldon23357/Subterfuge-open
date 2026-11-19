import React, { useEffect, useRef } from "react";
import type { PlayerMapGeometry } from "../../contracts/src/index.js";
import { drawSea, drawStation, drawSubmarine } from "./map-art.js";
import { homeCamera, zoomCameraAt, MAP_MIN_ZOOM, MAP_MAX_ZOOM } from "./map-camera.js";
import { colors } from "./theme.js";
import { mapNameFont, mapCountFont } from "./typography.js";
export function PlayerMap({
  view,
  selected,
  select,
}: {
  view: PlayerMapGeometry;
  selected: string;
  select: (key: string) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null),
    camera = useRef({ x: 0, y: 0, zoom: 1 }),
    initialized = useRef(false);
  const hits = useRef<{ key: string; x: number; y: number; radius: number }[]>(
    [],
  );
  const pointer = useRef<{
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const current = useRef(view);
  current.current = view;
  function home() {
    const canvas = ref.current;
    if (!canvas) return;
    camera.current = homeCamera(
      current.current.outposts
        .filter((o) => o.owner === current.current.player)
        .map((o) => o.position),
      current.current.size,
      { width: canvas.clientWidth, height: canvas.clientHeight },
    );
  }
  useEffect(() => {
    const canvas = ref.current!;
    let frame = 0,
      stopped = false;
    const mask = document.createElement("canvas"),
      ctx = canvas.getContext("2d")!,
      fog = mask.getContext("2d")!;
    function draw() {
      if (stopped) return;
      const w = canvas.clientWidth,
        h = canvas.clientHeight,
        dpr = Math.min(2, window.devicePixelRatio || 1);
      if (w <= 0 || h <= 0) {
        frame = requestAnimationFrame(draw);
        return;
      }
      if (
        canvas.width !== Math.round(w * dpr) ||
        canvas.height !== Math.round(h * dpr)
      ) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        mask.width = canvas.width;
        mask.height = canvas.height;
      }
      if (!initialized.current) {
        home();
        initialized.current = true;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      fog.setTransform(dpr, 0, 0, dpr, 0, 0);
      const base = Math.min(w / view.size.width, h / view.size.height) * 0.88,
        scale = base * camera.current.zoom;
      const extentX = view.size.width * scale,
        extentY = view.size.height * scale;
      camera.current.x =
        ((((camera.current.x + extentX / 2) % extentX) + extentX) % extentX) -
        extentX / 2;
      camera.current.y =
        ((((camera.current.y + extentY / 2) % extentY) + extentY) % extentY) -
        extentY / 2;
      const cx = w / 2 + camera.current.x,
        cy = h / 2 + camera.current.y;
      drawSea(ctx, w, h, cx, cy, scale, true);
      const copies = (
        p: { x: number; y: number },
        fn: (x: number, y: number) => void,
      ) => {
        const px = cx + p.x * scale,
          py = cy + p.y * scale;
        for (
          let ix = Math.ceil((-120 - px) / extentX);
          ix <= Math.floor((w + 120 - px) / extentX);
          ix++
        )
          for (
            let iy = Math.ceil((-120 - py) / extentY);
            iy <= Math.floor((h + 120 - py) / extentY);
            iy++
          )
            fn(px + ix * extentX, py + iy * extentY);
      };
      fog.globalCompositeOperation = "source-over";
      fog.clearRect(0, 0, w, h);
      fog.fillStyle = "rgba(2,9,16,.55)";
      fog.fillRect(0, 0, w, h);
      fog.globalCompositeOperation = "destination-out";
      for (const area of view.sonar) {
        const px = cx + area.center.x * scale,
          py = cy + area.center.y * scale,
          r = area.radius * scale;
        for (
          let ix = Math.ceil((-r - px) / extentX);
          ix <= Math.floor((w + r - px) / extentX);
          ix++
        )
          for (
            let iy = Math.ceil((-r - py) / extentY);
            iy <= Math.floor((h + r - py) / extentY);
            iy++
          ) {
            fog.beginPath();
            fog.arc(px + ix * extentX, py + iy * extentY, r, 0, Math.PI * 2);
            fog.fill();
          }
      }
      if (!view.fullMapVisible)
        ctx.drawImage(mask, 0, 0, mask.width, mask.height, 0, 0, w, h);
      hits.current = [];
      for (const area of view.sonar)
        copies(area.center, (x, y) => {
          ctx.strokeStyle = "#a5d9cf38";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y, area.radius * scale, 0, Math.PI * 2);
          ctx.stroke();
        });

      for (const o of view.outposts)
        copies(o.position, (x, y) => {
          const key = "o:" + o.id;
          hits.current.push({ key, x, y, radius: 33 });
          ctx.save();
          ctx.translate(x, y);
          if (o.visibility === 0) {
            ctx.strokeStyle = "#7f919e";
            ctx.setLineDash([3, 4]);
            ctx.beginPath();
            ctx.arc(0, 0, 17, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.font = mapCountFont;
            ctx.fillStyle = "#b2bdc5";
            ctx.textAlign = "center";
            ctx.fillText("?", 0, 5);
          } else if (o.destroyed) {
            ctx.strokeStyle = "#a7a6a1";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(-11, -11);
            ctx.lineTo(11, 11);
            ctx.moveTo(11, -11);
            ctx.lineTo(-11, 11);
            ctx.stroke();
          } else
            drawStation(
              ctx,
              o.type!,
              o.owner === undefined || o.owner === null
                ? "#aeb7bd"
                : colors[o.owner]!,
              o.shield ?? 0,
              o.shieldMax ?? 0,
            );
          if (selected === key) {
            ctx.strokeStyle = "#f2deb2";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, 31, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.fillStyle = o.owner == null ? "#bdc9cc" : colors[o.owner]!;
          ctx.textAlign = "center";
          ctx.font = mapNameFont;
          ctx.fillText(o.id, 0, -36);
          if (o.visibility === 2) {
            ctx.font = mapCountFont;
            ctx.fillStyle = "#edf2ec";
            ctx.fillText(`${o.drillers} / ${o.shield}`, 0, 48);
          }


          ctx.restore();
        });

      for (const f of view.fleets)
        copies(f.position, (x, y) => {
          const key = "f:" + f.id;
          hits.current.push({ key, x, y, radius: 25 });
          ctx.save();
          ctx.translate(x, y);
          const target =
            f.destination?.kind === "fleet"
              ? view.fleets.find((o) => o.id === f.destination!.id)?.position
              : view.outposts.find((o) => o.id === f.destination?.id)?.position;
          const dx = target ? target.x - f.position.x : 1,
            dy = target ? target.y - f.position.y : 0;
          const angle = Math.atan2(
            dy - Math.round(dy / view.size.height) * view.size.height,
            dx - Math.round(dx / view.size.width) * view.size.width,
          );
          drawSubmarine(ctx, colors[f.owner]!, angle, f.drillers);
          if (selected === key) {
            ctx.strokeStyle = "#f2deb2";
            ctx.beginPath();
            ctx.arc(0, 0, 28, 0, Math.PI * 2);
            ctx.stroke();
          }
          ctx.restore();
        });
      frame = requestAnimationFrame(draw);
    }
    frame = requestAnimationFrame(draw);
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
    };
  }, [view, selected]);
  return (
    <div className="player-map">
      <canvas
        ref={ref}
        aria-label={
          view.fullMapVisible
            ? "终局海图：全图情报已公开。可拖动平移，滚轮缩放，也可使用右侧据点列表。"
            : "玩家海图：明亮区域为当前声呐范围，问号表示未知据点。可拖动平移，滚轮缩放，也可使用右侧据点列表。"
        }
        role="img"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pointer.current = {
            x: e.clientX,
            y: e.clientY,
            startX: e.clientX,
            startY: e.clientY,
            moved: false,
          };
        }}
        onPointerMove={(e) => {
          const p = pointer.current;
          if (!p) return;
          camera.current.x += e.clientX - p.x;
          camera.current.y += e.clientY - p.y;
          p.x = e.clientX;
          p.y = e.clientY;
          p.moved ||=
            Math.hypot(e.clientX - p.startX, e.clientY - p.startY) > 5;
        }}
        onPointerUp={(e) => {
          const p = pointer.current;
          pointer.current = null;
          if (!p || p.moved) return;
          const box = e.currentTarget.getBoundingClientRect(),
            x = e.clientX - box.left,
            y = e.clientY - box.top;
          const hit = [...hits.current]
            .reverse()
            .find((h) => Math.hypot(x - h.x, y - h.y) <= h.radius);
          if (hit) select(hit.key);
        }}
        onPointerCancel={() => {
          pointer.current = null;
        }}
        onWheel={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          camera.current = zoomCameraAt(
            camera.current,
            Math.max(
              MAP_MIN_ZOOM,
              Math.min(MAP_MAX_ZOOM, camera.current.zoom * Math.exp(-e.deltaY * 0.0015)),
            ),
            {
              x: e.clientX - box.left - box.width / 2,
              y: e.clientY - box.top - box.height / 2,
            },
          );
        }}
      />
      <div className="player-map-tools">
        <button onClick={home}>定位己方</button>
        <button
          aria-label="放大海图"
          onClick={() => {
            camera.current = zoomCameraAt(
              camera.current,
              Math.min(MAP_MAX_ZOOM, camera.current.zoom * 1.3),
              { x: 0, y: 0 },
            );
          }}
        >
          ＋
        </button>
        <button
          aria-label="缩小海图"
          onClick={() => {
            camera.current = zoomCameraAt(
              camera.current,
              Math.max(MAP_MIN_ZOOM, camera.current.zoom / 1.3),
              { x: 0, y: 0 },
            );
          }}
        >
          −
        </button>
      </div>
      <div className="player-map-legend">
        {view.fullMapVisible
          ? "对局已结束 · 全图情报已公开"
          : "声呐范围内可见舰数 · 问号为未知据点"}
      </div>
    </div>
  );
}
