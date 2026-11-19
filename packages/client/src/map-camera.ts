export const MAP_MIN_ZOOM = 1;
export const MAP_MAX_ZOOM = 3;

/** Frame owned territory using the smallest wrapped interval on each map axis. */
export function homeCamera(
  points: { x: number; y: number }[],
  size: { width: number; height: number },
  viewport: { width: number; height: number },
) {
  const axis = (values: number[], extent: number) => {
    if (!values.length) return { center: 0, span: extent / 3 };
    const sorted = values
      .map((v) => ((v % extent) + extent) % extent)
      .sort((a, b) => a - b);
    let gap = -1,
      start = sorted[0]!;
    for (let i = 0; i < sorted.length; i++) {
      const end = i + 1 < sorted.length ? sorted[i + 1]! : sorted[0]! + extent;
      if (end - sorted[i]! > gap) {
        gap = end - sorted[i]!;
        start = end % extent;
      }
    }
    const span = extent - gap;
    return { center: (start + span / 2) % extent, span };
  };
  const x = axis(
      points.map((p) => p.x),
      size.width,
    ),
    y = axis(
      points.map((p) => p.y),
      size.height,
    );
  const base =
    Math.min(viewport.width / size.width, viewport.height / size.height) * 0.88;
  const fit = Math.min(
    Math.max(120, viewport.width - 180) / Math.max(x.span, size.width * 0.12),
    Math.max(100, viewport.height - 150) / Math.max(y.span, size.height * 0.12),
  );
  const zoom = Math.max(MAP_MIN_ZOOM, Math.min(MAP_MAX_ZOOM, fit / base)),
    scale = base * zoom;
  return { x: -x.center * scale, y: -y.center * scale, zoom };
}

export interface MapCamera {
  x: number;
  y: number;
  zoom: number;
}
/** Keep the world point under an anchor fixed while changing map scale. */
export function zoomCameraAt(
  camera: MapCamera,
  zoom: number,
  anchor: { x: number; y: number },
): MapCamera {
  const ratio = zoom / camera.zoom;
  return {
    x: anchor.x + (camera.x - anchor.x) * ratio,
    y: anchor.y + (camera.y - anchor.y) * ratio,
    zoom,
  };
}
/** Time-based easing in log space makes wheel zoom independent of frame rate. */
export function easeMapZoom(
  current: number,
  target: number,
  elapsedMs: number,
): number {
  const difference = Math.log(target / current);
  return Math.abs(difference) < 0.0001
    ? target
    : current *
        Math.exp(difference * (1 - Math.exp(-Math.max(0, elapsedMs) / 75)));
}
