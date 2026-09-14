// Generates the checked-in OpenAPI artifact from the compiled public source.
// JSON.stringify has deterministic insertion order for this object; keeping this script
// dependency-free avoids adding a Swagger runtime dependency to the host.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const source = pathToFileURL(resolve(root, "dist/public-api/openapi-v1.js")).href;
const { openapiV1 } = await import(source);
const output = `${JSON.stringify(openapiV1, null, 2)}\n`;

for (const file of ["openapi/v1.json", "dist/openapi/v1.json"]) {
  const target = resolve(root, file);
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, output, "utf8");
}
