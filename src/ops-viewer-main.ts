import { createViewerData } from "./ops-viewer/data.js";
import { createViewerServer } from "./ops-viewer/server.js";

const dbPath = process.env.OPS_VIEWER_DB_PATH;
const dataDir = process.env.OPS_VIEWER_DATA_DIR;
if (!dbPath || !dataDir) throw new Error("OPS_VIEWER_DB_PATH and OPS_VIEWER_DATA_DIR are required");
const host = process.env.OPS_VIEWER_HOST || "127.0.0.1";
const port = Number(process.env.OPS_VIEWER_PORT || "18082");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid OPS_VIEWER_PORT");
const data = createViewerData(dbPath, dataDir);
const server = createViewerServer(data);
server.on("error", () => { data.close(); process.exitCode = 1; });
server.listen(port, host, () => console.log(`ops session viewer listening at http://${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => { data.close(); process.exit(0); }));
}
