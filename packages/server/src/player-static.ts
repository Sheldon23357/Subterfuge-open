import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
/** Serve only the public player entry/bundle and shared art. The lab bundle and
 * local credentials are deliberately outside this allowlist. */
export async function servePlayerStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (req.method !== "GET") return false;
  const path = new URL(req.url ?? "/", "http://player.local").pathname;
  if (
    !["/", "/player.html", "/player.js", "/player.css", "/prediction-worker.js", "/fleet-arrival-worker.js"].includes(path) &&
    !path.startsWith("/assets/") &&
    !/^\/audio\/(bgm|sfx)\/[a-z0-9_]+\.(ogg|mp3)$/.test(path)
  )
    return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path === "/" ? "/player.html" : path);
  } catch {
    return false;
  }
  const base = resolve(root),
    file = resolve(base, "." + decoded);
  if (!file.startsWith(base + sep)) return false;
  if (
    !["/player.html", "/player.js", "/player.css", "/prediction-worker.js", "/fleet-arrival-worker.js"].includes(decoded) &&
    !file.startsWith(resolve(base, "assets") + sep) &&
    !/^\/audio\/(bgm|sfx)\/[a-z0-9_]+\.(ogg|mp3)$/.test(decoded)
  )
    return false;
  try {
    const data = await readFile(file);
    res.setHeader(
      "Content-Type",
      (
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".ogg": "audio/ogg",
          ".mp3": "audio/mpeg",
          ".ttf": "font/ttf",
          ".woff2": "font/woff2",
        } as Record<string, string>
      )[extname(file)] ?? "application/octet-stream",
    );
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    res.end(data);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      res.writeHead(404).end();
      return true;
    }
    throw e;
  }
}
