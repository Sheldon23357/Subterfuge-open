import { mapNameFont, mapCountFont, mapHintFont } from "./typography.js";
import { homeCamera, zoomCameraAt, easeMapZoom, MAP_MIN_ZOOM, MAP_MAX_ZOOM } from "./map-camera.js";
import { arrivalWorldDays } from "./time.js";
import {preparingFleet} from './fleet-preparation.js';
import {
  drawStation,
  drawSubmarine,
  drawGift,
  drawSea,
  drawMapBadge,
} from "./map-art.js";
import React, { useEffect, useRef } from "react";
import type { GameView } from "./game-view.js";
import { colors, type Settings } from "./theme.js";
import { knownOutpostSonarRange } from './known-sonar.js';
import {territoryCenters} from './territory-labels.js';
import {drawTerritoryNameplates} from './territory-nameplates.js';
import type {AiMapStatus} from './AiStatusStrip.js';
import {RouteMeasurement} from './route-measurement.js';
export function SeaMap({
  view,
  selected,
  focus,
  select,
  settings,
  player,
  dispatch,
  onRoute,
  onRouteEnd,
  routeLabel,
  draftRoute,
  estimate,
  obscured = false,
  animateFleets = true,
  aiStatus = {seats:[],unavailable:false},
}: {
  view: GameView;
  obscured?: boolean;
  animateFleets?: boolean;
  aiStatus?:AiMapStatus;
  selected: string;
  focus?: {id: string} | null;
  select: (id: string, point?: { x: number; y: number }) => void;
  settings: Settings;
  player: number;
  routeLabel: string;
  draftRoute: { source: string; target: string } | null;
  onRoute: (source: string, point: { x: number; y: number }) => void;
  onRouteEnd: (valid: boolean) => void;
  estimate: (
    source: string,
    point: { x: number; y: number },
    issueTick: number,
    signal: AbortSignal,
  ) => Promise<{ minutes: number | null; arrivalTick: number | null }>;
  dispatch: (
    source: string,
    target: string,
    point: { x: number; y: number },
  ) => void;
}) {
  const allOutposts = [
    ...view.outposts,
    ...(view.perspective?.unseenOutposts ?? []),
  ];
  const outpostIds = new Set(allOutposts.map(o => o.id));
  const liveAiStatus=useRef(aiStatus);liveAiStatus.current=aiStatus;
  const measuring = allOutposts.some(
    (o) => o.id === selected && o.owner !== player,
  );
  const canvas = useRef<HTMLCanvasElement>(null),
    camera = useRef({ x: 0, y: 0, zoom: 1 }),
    cameraWorld = useRef(''),
    hits = useRef<{ id: string; x: number; y: number; radius: number }[]>([]),
    drag = useRef<{
      x: number;
      y: number;
      px: number;
      py: number;
      moved: boolean;
    } | null>(null);
  const route = useRef<{
    source: string;
    x: number;
    y: number;
    ex: number;
    ey: number;
    target: string | undefined;
  } | null>(null);
  const measurement = useRef<{ source: string; target: string } | null>(null);
  const measureLabel = useRef("计算抵达时间…");
  const measureEstimator = useRef(new RouteMeasurement());
  function measureTime(source: string, point: { x: number; y: number }) {
    measureEstimator.current.schedule({
      source, point, tick: view.tick, estimate,
      result: result => {
        measureLabel.current =
          result.minutes === null
            ? "超出推演范围"
            : `预计抵达 ${arrivalWorldDays(result.minutes)}`;
      },
      error: () => { measureLabel.current = "无法估算航线"; },
    });
  }
  useEffect(() => {
    measureLabel.current = "计算抵达时间…";
    measurement.current = null;
    route.current = null;
    return () => {
      measureEstimator.current.cancel();
    };
  }, [measuring, selected]);
  const previous = useRef<GameView | null>(null);
  const previousFleetAnimation = useRef(animateFleets);
  const previousScale = useRef<number | null>(null);
  const zoomTarget = useRef(1);
  const zoomAnchor = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const c = canvas.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      if (drag.current) return;
      const box = c.getBoundingClientRect();
      zoomAnchor.current = {
        x: e.clientX - box.left - box.width / 2,
        y: e.clientY - box.top - box.height / 2,
      };
      const pixels =
        e.deltaY *
        (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? box.height : 1);
      zoomTarget.current = Math.max(
        MAP_MIN_ZOOM,
        Math.min(
          MAP_MAX_ZOOM,
          zoomTarget.current *
            Math.exp(-Math.max(-1000, Math.min(1000, pixels)) * 0.0015),
        ),
      );
    };
    c.addEventListener("wheel", wheel, { passive: false });
    return () => c.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    const cancel = () => {
      if (route.current) {
        route.current = null;
        drag.current = null;
        onRouteEnd(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel();
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key);
    };
  }, [onRouteEnd]);
  useEffect(() => {
    if (!canvas.current) return;
    const owned = view.outposts.filter((o) => o.owner === player);
    const origin = allOutposts.find(
      (o) =>
        o.id ===
        view.map?.startingOrigins.find((q) => q.owner === player)?.outpostId,
    );
    const worldKey=`${view.map?.seed??''}:${view.map?.players??''}:${view.size.width}:${view.size.height}`;
    const home = homeCamera(
      owned.length
        ? owned.map((o) => o.position)
        : origin
          ? [origin.position]
          : [],
      view.size,
      canvas.current.getBoundingClientRect(),
    );
    if(cameraWorld.current===worldKey){
      // Switching perspective recenters the territory without changing either
      // the current zoom or a wheel gesture's pending zoom target.
      camera.current=zoomCameraAt(home,camera.current.zoom,{x:0,y:0});
      zoomAnchor.current={x:0,y:0};
    }else{
      camera.current=home;
      zoomTarget.current=home.zoom;
      cameraWorld.current=worldKey;
    }
    const box = canvas.current.getBoundingClientRect();
    previousScale.current =
      Math.min(box.width / view.size.width, box.height / view.size.height) *
      0.88 *
      camera.current.zoom;
  }, [view.map?.seed, view.map?.players, player]);
  useEffect(() => {
    if (!focus || !canvas.current) return;
    const post = allOutposts.find(o => o.id === focus.id);
    if (!post) return;
    const box = canvas.current.getBoundingClientRect();
    const zoom = camera.current.zoom;
    const scale = Math.min(box.width / view.size.width, box.height / view.size.height) * 0.88 * zoom;
    camera.current = {x: -post.position.x * scale, y: -post.position.y * scale, zoom};
    zoomTarget.current = zoom;
    zoomAnchor.current = {x: 0, y: 0};
    previousScale.current = scale;
  }, [focus]);
  useEffect(() => {
    const start = performance.now();
    const interpolateFleets = animateFleets && previousFleetAnimation.current;
    const c = canvas.current!,
      ctx = c.getContext("2d")!,
      fogCanvas = document.createElement("canvas"),
      fog = fogCanvas.getContext("2d")!;
    let frame = 0,
      lastFrameTime = performance.now();
    let fogKey = "";
    const centers=territoryCenters(allOutposts,view.size);
    const draw = (time: number) => {
      const motion = settings.motion && !matchMedia("(prefers-reduced-motion: reduce)").matches;
      const box = c.getBoundingClientRect(),
        w = box.width,
        h = box.height,
        dpr = window.devicePixelRatio || 1;
      if (c.width !== w * dpr || c.height !== h * dpr) {
        c.width = w * dpr;
        c.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cam = camera.current;
      let scale =
        Math.min(w / view.size.width, h / view.size.height) * 0.88 * cam.zoom;
      if (previousScale.current && previousScale.current !== scale) {
        cam.x *= scale / previousScale.current;
        cam.y *= scale / previousScale.current;
      }
      const elapsed = Math.min(50, Math.max(0, time - lastFrameTime));
      lastFrameTime = time;
      const nextZoom =
        motion
          ? easeMapZoom(cam.zoom, zoomTarget.current, elapsed)
          : zoomTarget.current;
      if (nextZoom !== cam.zoom) {
        Object.assign(cam, zoomCameraAt(cam, nextZoom, zoomAnchor.current));
        scale =
          Math.min(w / view.size.width, h / view.size.height) * 0.88 * cam.zoom;
      }
      previousScale.current = scale;
      const cx = w / 2 + cam.x,
        cy = h / 2 + cam.y;
      ctx.globalAlpha = 1;
      const primaryX = Math.round(-cam.x / (view.size.width * scale)),
        primaryY = Math.round(-cam.y / (view.size.height * scale));
      ctx.lineWidth = 1;
      drawSea(ctx, w, h, cx, cy, scale, settings.grid);
      if (view.perspective && !view.perspective.fullMapVisible) {
        // Sonar is fixed for this view. Rebuild its mask only when the camera
        // or backing dimensions change, rather than reallocating it each RAF.
        const nextFogKey = `${c.width}:${c.height}:${dpr}:${w}:${h}:${cx}:${cy}:${scale}`;
        if (nextFogKey !== fogKey) {
          fogKey = nextFogKey;
          fogCanvas.width = c.width;
          fogCanvas.height = c.height;
          fog.setTransform(dpr, 0, 0, dpr, 0, 0);
          fog.fillStyle = "rgba(2,9,16,.58)";
          fog.fillRect(0, 0, w, h);
          fog.globalCompositeOperation = "destination-out";
          // Clear visible areas completely; reusing the fog's translucent fill
          // leaves a veil inside sonar and makes overlapping areas look brighter.
          fog.fillStyle = "#000";
          for (const area of view.perspective.sonar) {
            const ax = cx + area.center.x * scale,
              ay = cy + area.center.y * scale,
              r = area.radius * scale;
            for (
              let x = Math.ceil((-r - ax) / (view.size.width * scale));
              x <= Math.floor((w + r - ax) / (view.size.width * scale));
              x++
            )
              for (
                let y = Math.ceil((-r - ay) / (view.size.height * scale));
                y <= Math.floor((h + r - ay) / (view.size.height * scale));
                y++
              ) {
                fog.beginPath();
                fog.arc(
                  ax + x * view.size.width * scale,
                  ay + y * view.size.height * scale,
                  r,
                  0,
                  Math.PI * 2,
                );
                fog.fill();
              }
          }
        }
        ctx.drawImage(fogCanvas, 0, 0, c.width, c.height, 0, 0, w, h);
      }

      const selectedPost=allOutposts.find(o=>o.id===selected);
      if(selectedPost&&selectedPost.owner!==player){
        // Prefer authorized sonar; otherwise use the ordinary outpost radius.
        const knownArea=view.perspective?.sonar.find(a=>a.center.x===selectedPost.position.x&&a.center.y===selectedPost.position.y);
        const radius=(knownArea?.radius??knownOutpostSonarRange(view,selectedPost.id))*scale;
        const ax=cx+selectedPost.position.x*scale,ay=cy+selectedPost.position.y*scale;
        const color=selectedPost.owner==null?(colors[player]??'#9ab7bd'):(colors[selectedPost.owner]??'#9ab7bd');
        ctx.save();
        ctx.fillStyle=color+'16';ctx.strokeStyle=color+'88';ctx.lineWidth=1;
        ctx.setLineDash([4,5]);
        for(let x=Math.ceil((-radius-ax)/(view.size.width*scale));x<=Math.floor((w+radius-ax)/(view.size.width*scale));x++)
          for(let y=Math.ceil((-radius-ay)/(view.size.height*scale));y<=Math.floor((h+radius-ay)/(view.size.height*scale));y++){
            ctx.beginPath();ctx.arc(ax+x*view.size.width*scale,ay+y*view.size.height*scale,radius,0,Math.PI*2);ctx.fill();ctx.stroke();
          }
        ctx.restore();
      }

      const routePadding = (id: string | undefined) => {
        if (!id) return 0;
        return view.outposts.some((o) => o.id === id)
          ? 28 * (view.map || view.perspective ? Math.min(1, scale / 25) : 1) +
              1
          : 26;
      };
      const strokeRoute = (
        ax: number,
        ay: number,
        bx: number,
        by: number,
        source: string,
        target?: string,
        endpointExtension = 0,
      ) => {
        const dx = bx - ax,
          dy = by - ay,
          length = Math.hypot(dx, dy);
        const start = Math.max(0, routePadding(source) - endpointExtension),
          end = Math.max(0, routePadding(target) - endpointExtension);
        if (length <= start + end) return;
        ctx.save();
        ctx.globalAlpha = 0.5;
        ctx.beginPath();
        ctx.moveTo(ax + (dx / length) * start, ay + (dy / length) * start);
        ctx.lineTo(bx - (dx / length) * end, by - (dy / length) * end);
        ctx.stroke();
        ctx.restore();
      };
      // Wrapped copies share identical positions and hit testing; routes use shortest world displacement.
      hits.current = [];
      const measurementLabels: { x: number; y: number }[] = [];

      const drawFleets: (() => void)[] = [];
      for (
        let ox = Math.floor(-cx / (view.size.width * scale)) - 1;
        ox <= Math.ceil((w - cx) / (view.size.width * scale)) + 1;
        ox++
      )
        for (
          let oy = Math.floor(-cy / (view.size.height * scale)) - 1;
          oy <= Math.ceil((h - cy) / (view.size.height * scale)) + 1;
          oy++
        ) {
          const primary = ox === primaryX && oy === primaryY;
          ctx.globalAlpha = 1;
          const pos = (p: { x: number; y: number }) => ({
            x: cx + (p.x + ox * view.size.width) * scale,
            y: cy + (p.y + oy * view.size.height) * scale,
          });
          const shownRoute = measuring ? measurement.current : draftRoute;
          if (shownRoute && !route.current) {
            const source =
              allOutposts.find((o) => o.id === shownRoute.source) ??
              view.fleets.find((f) => f.id === shownRoute.source);
            const target =
              allOutposts.find((o) => o.id === shownRoute.target) ??
              view.fleets.find((f) => f.id === shownRoute.target);
            if (source && target) {
              const a = pos(source.position);
              const dx = target.position.x - source.position.x,
                dy = target.position.y - source.position.y;
              const b = {
                x:
                  a.x +
                  (dx - Math.round(dx / view.size.width) * view.size.width) *
                    scale,
                y:
                  a.y +
                  (dy - Math.round(dy / view.size.height) * view.size.height) *
                    scale,
              };
              ctx.save();
              ctx.strokeStyle =
                source.owner == null ? "#95917e" : colors[source.owner]!;
              ctx.lineWidth = 1;
              ctx.lineCap = "round";
              ctx.setLineDash([6, 5]);
              strokeRoute(
                a.x,
                a.y,
                b.x,
                b.y,
                shownRoute.source,
                shownRoute.target,
              );
              ctx.setLineDash([]);
              ctx.beginPath();
              ctx.arc(b.x, b.y, 30, 0, Math.PI * 2);
              ctx.stroke();
              if (measuring) {
                measurementLabels.push({
                  x: (a.x + b.x) / 2,
                  y: (a.y + b.y) / 2 - 12,
                });
              }
              ctx.restore();
            }
          }
          for (const f of view.fleets) {
            const target =
              allOutposts.find((o) => o.id === f.destination)?.position ??
              view.fleets.find((o) => o.id === f.destination)?.position;
            if (!target) continue;
            const a = pos(f.position),
              dx = target.x - f.position.x,
              dy = target.y - f.position.y;
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([]);
            ctx.strokeStyle = colors[f.owner]!;
            ctx.lineWidth = 1;
            ctx.lineCap = "round";
            strokeRoute(
              a.x,
              a.y,
              a.x +
                (dx - Math.round(dx / view.size.width) * view.size.width) *
                  scale,
              a.y +
                (dy - Math.round(dy / view.size.height) * view.size.height) *
                  scale,
              f.id,
              f.destination,
              6,
            );
            ctx.restore();
          }
          for (const o of view.perspective?.unseenOutposts ?? []) {
            const p = pos(o.position);
            if (p.x < -100 || p.x > w + 100 || p.y < -100 || p.y > h + 100)
              continue;
            const glyph = Math.min(1, scale / 25);
            hits.current.push({
              id: o.id,
              ...p,
              radius: Math.max(14, 28 * glyph),
            });
            ctx.save();
            ctx.translate(p.x, p.y);
            const color=o.owner==null?'#899da6':colors[o.owner]??'#899da6';
            const radius=Math.max(4.5,7*glyph);
            ctx.strokeStyle = color;
            ctx.lineWidth=2.5;
            ctx.lineJoin='miter';
            ctx.beginPath();ctx.moveTo(0,-radius);ctx.lineTo(radius,0);ctx.lineTo(0,radius);ctx.lineTo(-radius,0);ctx.closePath();ctx.stroke();
            const nameAlpha=selected===o.id?1:Math.max(0,Math.min(1,(cam.zoom-1.2)/0.6));
            if(settings.labels&&nameAlpha>0){
              ctx.save();ctx.globalAlpha=nameAlpha;
              ctx.font=mapHintFont;ctx.textAlign='left';ctx.fillStyle=color;
              ctx.fillText(view.perspective?.outpostNames[o.id]??o.id,radius+8,4);
              ctx.restore();
            }
            if (selected === o.id) {
              ctx.strokeStyle = "#e6d2a4";
              ctx.beginPath();
              ctx.lineWidth=1;
              ctx.arc(0, 0, radius+6, 0, Math.PI * 2);
              ctx.stroke();
            }
            ctx.restore();
          }
          for (const o of view.outposts) {
            const primary =
              ox ===
                Math.round((-cam.x / scale - o.position.x) / view.size.width) &&
              oy ===
                Math.round((-cam.y / scale - o.position.y) / view.size.height);
            ctx.globalAlpha = 1;
            const p = pos(o.position),
              color = o.owner === null ? "#95917e" : colors[o.owner]!;
            if (p.x < -100 || p.x > w + 100 || p.y < -100 || p.y > h + 100)
              continue;
            hits.current.push({
              id: o.id,
              ...p,
              radius:
                view.map || view.perspective
                  ? Math.max(14, 28 * Math.min(1, scale / 25))
                  : 28,
            });
            if (selected === o.id) {
              ctx.fillStyle = color + "08";
              ctx.beginPath();
              ctx.arc(p.x, p.y, 40, 0, Math.PI * 2);
              ctx.fill();
              ctx.strokeStyle = color + "55";
              ctx.setLineDash([3, 7]);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.strokeStyle = color;
              ctx.beginPath();
              ctx.arc(
                p.x,
                p.y,
                29 +
                  (motion
                    ? Math.sin(time / 700) * 2
                    : 0),
                0,
                Math.PI * 2,
              );
              ctx.stroke();
            }
            ctx.save();
            ctx.translate(p.x, p.y);
            const glyph =
              view.map || view.perspective ? Math.min(1, scale / 25) : 1;
            ctx.scale(glyph, glyph);
            drawStation(
              ctx,
              o.type,
              color,
              o.shieldsEnabled ? o.shield : 0,
              o.shieldMax,
              o.owner === null || view.players[o.owner]?.active !== false,
            );
            ctx.restore();
            if (o.minePending)
              drawMapBadge(
                ctx,
                "DrillMineButton",
                p.x - 30 * glyph,
                p.y + 27 * glyph,
                14,
              );
            if (!o.shieldsEnabled && o.shieldMax > 0)
              drawMapBadge(
                ctx,
                "ShieldButton",
                p.x + 29 * glyph,
                p.y + 27 * glyph,
                12,
                "#8b969e",
              );



            if (settings.labels) {
              // Fade station names out in the overview; troop counts stay readable.
              const nameAlpha = Math.max(
                0,
                Math.min(1, (cam.zoom - 1.2) / 0.6),
              );
              if (nameAlpha > 0) {
                ctx.save();
                ctx.globalAlpha *= nameAlpha;
                ctx.textAlign = "left";
                ctx.fillStyle = color;
                ctx.font = mapNameFont;
                ctx.fillText(o.name ?? o.id, p.x + glyph * 32, p.y + 4);
                ctx.restore();
              }
              ctx.fillStyle = color;
              ctx.font = mapCountFont;
              ctx.textAlign = "center";
              if (o.owner !== null || o.drillers > 0 || selected === o.id)
                ctx.fillText(String(o.drillers), p.x, p.y + glyph * 36);
            }
          }
          for (const f of view.fleets) {
            drawFleets.push(() => {
              const primary =
                ox ===
                  Math.round((-cam.x / scale - f.position.x) / view.size.width) &&
                oy ===
                  Math.round((-cam.y / scale - f.position.y) / view.size.height);
              ctx.globalAlpha = 1;
              const old =
                previous.current?.fleets.find((x) => x.id === f.id)?.position ??
                f.position;
              const t =
                interpolateFleets && motion
                  ? Math.min(1, (time - start) / 700)
                  : 1;
              const dx = f.position.x - old.x,
                dy = f.position.y - old.y;
              const p = pos({
                x:
                  old.x +
                  (dx - Math.round(dx / view.size.width) * view.size.width) * t,
                y:
                  old.y +
                  (dy - Math.round(dy / view.size.height) * view.size.height) * t,
              });
              const destinationUnit =
                allOutposts.find((o) => o.id === f.destination);
              const destination = destinationUnit?.position;
              const vx = destination ? destination.x - f.position.x : 1,
                vy = destination ? destination.y - f.position.y : 0;
              const angle = Math.atan2(
                vy - Math.round(vy / view.size.height) * view.size.height,
                vx - Math.round(vx / view.size.width) * view.size.width,
              );
              if (
                preparingFleet(f) &&
                animateFleets &&
                motion
              ) {
                const phase = (time % 1800) / 1000;
                const spring =
                  phase < 0.9
                    ? Math.sin(phase * 18) * Math.exp(-phase * 4.5) * 5
                    : 0;
                p.x += Math.cos(angle) * spring;
                p.y += Math.sin(angle) * spring;
              }
              ctx.save();
              ctx.translate(p.x, p.y);
              hits.current.push({ id: f.id, ...p, radius: 20 });
              drawSubmarine(
                ctx,
                colors[f.owner]!,
                angle,
                settings.labels ? f.drillers : undefined,
                f.gift && destinationUnit?.owner != null
                  ? {
                      color: colors[destinationUnit.owner]!,
                      amount:
                        animateFleets && motion
                          ? (1 - Math.cos((time / 3000) * Math.PI * 2)) / 2
                          : 0.5,
                    }
                  : undefined,
              );
              ctx.restore();
              if (selected === f.id) {
                ctx.strokeStyle = "#e5ffff";
                ctx.strokeRect(p.x - 18, p.y - 12, 36, 24);
              }


              if (f.gift) {
                drawGift(
                  ctx,
                  p.x + 21,
                  p.y + 3,
                  destinationUnit?.owner != null
                    ? colors[destinationUnit.owner]!
                    : "#fff",
                );
              }
            });
          }
        }
      // Complete every wrapped station copy before drawing foreground units.

      for (const draw of drawFleets) draw();
      drawTerritoryNameplates(ctx,centers,view.size,{width:w,height:h,cx,cy,scale},liveAiStatus.current,time,motion);
      const line = route.current;
      // Draw time hints after every wrapped map copy so units cannot cover them.
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.font = mapHintFont;
      ctx.textAlign = "center";
      for (const { x, y } of measurementLabels) {
        const label = measureLabel.current;
        const width = ctx.measureText(label).width;
        ctx.fillStyle = "#10212aee";
        ctx.fillRect(x - width / 2 - 9, y - 16, width + 18, 25);
        ctx.fillStyle = "#d7edf1";
        ctx.fillText(label, x, y + 1);
      }
      ctx.restore();
      if (line) {
        ctx.save();
        ctx.globalAlpha = 1;
        const origin =
          allOutposts.find((o) => o.id === line.source) ??
          view.fleets.find((f) => f.id === line.source);
        ctx.strokeStyle =
          origin?.owner == null ? "#95917e" : colors[origin.owner]!;
        ctx.lineWidth = 1;
        ctx.lineCap = "round";
        ctx.setLineDash([5, 5]);
        strokeRoute(line.x, line.y, line.ex, line.ey, line.source, line.target);
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(line.ex, line.ey, 24, 0, Math.PI * 2);
        ctx.stroke();
        ctx.font = mapHintFont;
        ctx.textAlign = "center";
        const label = measuring
          ? measureLabel.current
          : routeLabel || "计算抵达时间…";
        const lx = Math.max(120, Math.min(w - 120, (line.x + line.ex) / 2)),
          ly = Math.max(24, Math.min(h - 24, (line.y + line.ey) / 2 - 18));
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = "#0a202af0";
        ctx.fillRect(lx - tw / 2 - 10, ly - 17, tw + 20, 28);
        ctx.fillStyle = "#c5f5e9";
        ctx.fillText(label, lx, ly + 2);
        ctx.restore();
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      previous.current = view;
      previousFleetAnimation.current = animateFleets;
    };
  }, [view, selected, settings, routeLabel, draftRoute, measuring, animateFleets, player]);
  return (
    <canvas
      ref={canvas}
      tabIndex={0}
      style={{
        cursor: measuring ? "crosshair" : undefined,
        visibility: obscured ? "hidden" : undefined,
        pointerEvents: obscured ? "none" : undefined,
      }}
      aria-hidden={obscured}
      aria-label="环绕世界海图，点击据点或潜艇查看详情"
      onPointerDown={(e) => {
        zoomTarget.current = camera.current.zoom;
        e.currentTarget.setPointerCapture(e.pointerId);
        const box = e.currentTarget.getBoundingClientRect(),
          x = e.clientX - box.left,
          y = e.clientY - box.top;
        const hit = hits.current.find(
          (p) => p.id === selected && Math.hypot(x - p.x, y - p.y) < p.radius,
        );
        if (
          hit &&
          (measuring ||
            view.outposts.some((o) => o.id === selected && o.owner === player))
        ) {
          measureEstimator.current.cancel();
          measureLabel.current = "计算抵达时间…";
          route.current = {
            source: hit.id,
            target: undefined,
            x: hit.x,
            y: hit.y,
            ex: x,
            ey: y,
          };
        }
        drag.current = {
          x: e.clientX,
          y: e.clientY,
          px: camera.current.x,
          py: camera.current.y,
          moved: false,
        };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x,
          dy = e.clientY - d.y;
        if (Math.hypot(dx, dy) > 4) d.moved = true;
        if (route.current) {
          const box = e.currentTarget.getBoundingClientRect();
          const x = e.clientX - box.left,
            y = e.clientY - box.top;
          let nearest: typeof hits.current[number] | undefined;
          let held: typeof nearest;
          let nearestDistance = Infinity;
          for (const p of hits.current) {
            if (p.id === route.current.source || (measuring && !outpostIds.has(p.id))) continue;
            const distance = Math.hypot(x - p.x, y - p.y);
            if (!held && p.id === route.current.target && distance < p.radius + 30) held = p;
            if (distance < p.radius + 20 && distance < nearestDistance) {
              nearest = p;
              nearestDistance = distance;
            }
          }
          const hit = held ?? nearest;
          route.current.ex = hit?.x ?? x;
          route.current.ey = hit?.y ?? y;
          route.current.target = hit?.id;
          const scale =
            Math.min(
              box.width / view.size.width,
              box.height / view.size.height,
            ) *
            0.88 *
            camera.current.zoom;
          if (measuring) {
            const width = view.size.width * scale,
              height = view.size.height * scale;
            route.current.ex -=
              Math.round((route.current.ex - route.current.x) / width) * width;
            route.current.ey -=
              Math.round((route.current.ey - route.current.y) / height) *
              height;
            measureTime(route.current.source, {
              x: (route.current.ex - box.width / 2 - camera.current.x) / scale,
              y: (route.current.ey - box.height / 2 - camera.current.y) / scale,
            });
            return;
          }
          onRoute(route.current.source, {
            x: (route.current.ex - box.width / 2 - camera.current.x) / scale,
            y: (route.current.ey - box.height / 2 - camera.current.y) / scale,
          });
          return;
        }
        camera.current.x = d.px + dx;
        camera.current.y = d.py + dy;
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        const line = route.current;
        route.current = null;
        if (line && d?.moved) {
          const hit = hits.current
            .filter(
              (p) =>
                p.id !== line.source &&
                Math.hypot(line.ex - p.x, line.ey - p.y) < p.radius,
            )
            .sort(
              (a, b) =>
                Math.hypot(line.ex - a.x, line.ey - a.y) -
                Math.hypot(line.ex - b.x, line.ey - b.y),
            )[0];
          if (measuring) {
            measurement.current =
              hit && allOutposts.some((o) => o.id === hit.id)
                ? { source: line.source, target: hit.id }
                : null;
            const target = allOutposts.find((o) => o.id === hit?.id);
            if (target) measureTime(line.source, target.position);
            else measureEstimator.current.cancel();
            return;
          }
          onRouteEnd(!!hit);
          if (hit) dispatch(line.source, hit.id, { x: hit.x, y: hit.y });
          return;
        }
        if (!d?.moved) {
          measureEstimator.current.cancel();
          const r = e.currentTarget.getBoundingClientRect(),
            x = e.clientX - r.left,
            y = e.clientY - r.top;
          const hit = hits.current
            .filter((p) => Math.hypot(x - p.x, y - p.y) < p.radius)
            .sort(
              (a, b) =>
                Math.hypot(x - a.x, y - a.y) - Math.hypot(x - b.x, y - b.y),
            )[0];
          measurement.current = null;
          select(hit?.id ?? "", hit ? { x: hit.x, y: hit.y } : undefined);
        } else {
          const r = e.currentTarget.getBoundingClientRect(),
            scale =
              Math.min(r.width / view.size.width, r.height / view.size.height) *
              0.88 *
              camera.current.zoom;
          camera.current.x %= view.size.width * scale;
          camera.current.y %= view.size.height * scale;
        }
      }}
      onPointerCancel={() => {
        measureEstimator.current.cancel();
        onRouteEnd(false);
        route.current = null;
        drag.current = null;
      }}
    />
  );
}
