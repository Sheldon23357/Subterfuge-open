import { resolve } from "node:path";
import { createServer } from "node:http";
import { createRoomHub } from "./room-hub.js";
const port = Number(process.env.LOBBY_PORT ?? 4312),
  host = process.env.LOBBY_HOST ?? "127.0.0.1";
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw Error("Invalid lobby port");
await new Promise<void>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(port, host, () =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
});
const hub = await createRoomHub({
  directory: resolve(process.env.LOBBY_DATA_DIR ?? "runtime-rooms"),
  webRoot: resolve("packages/client/public"),
});
await new Promise<void>((resolve, reject) => {
  hub.server.once("error", reject);
  hub.server.listen(port, host, resolve);
});
console.log(`游戏大厅：http://${host}:${port}`);
let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  void hub.close();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
