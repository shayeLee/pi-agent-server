import { restoreSqliteBackup } from "../../src/backup/restore-core.js";
import type { NativeRestorePhase } from "../../src/backup/native-payload.js";

const [serialized, phase] = process.argv.slice(2);
await restoreSqliteBackup({
  paths: JSON.parse(serialized!),
  age: { decrypt: bytes => Buffer.from(bytes.toString().split("\n")[1]!, "base64") },
  nativeRestoreCheckpoint(current: NativeRestorePhase) {
    if (current === phase) process.kill(process.pid, "SIGKILL");
  },
});
