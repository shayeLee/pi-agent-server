import { mkdtempSync, realpathSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Hermetic host-contract fixture, not an inspection of an installed global extension.
export function readExtensionFixture(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "subagent-extension-contract-")));
  const file = path.join(root, "index.ts");
  try {
    writeFileSync(file, `
\tpi.on("session_start", (_event, ctx) => {
      shuttingDown = false;
      hostMode = ctx.mode === "json";
      restoreFleetHistory();
      pi.events.emit("agent-team:host-transport", { version: 1, accept: value => { hostTransport = value; } });
    });
\tpi.on("session_shutdown", () => {});
\tconst notifications = new Map();
    let inflight = false;
    const report = async () => {
      if (shuttingDown || inflight) return;
      const runs = backgroundRuns.needsReminder();
      if (!runs.length) return;
      inflight = true;
      try {
        const key = runs.map(run => run.runId).join(",");
        let notification = notifications.get(key);
        if (!notification) {
          notification = { version: 1, notificationId: randomUUID(), runIds: runs.map(run => run.runId),
            text: runs.map(run => "### [" + run.agent + "] run " + run.runId + " — " + run.status + "\\n\\n" + getResultOutput(run.result)).join("\\n\\n"), appended: false };
          notifications.set(key, notification);
        }
        const { appended, ...data } = notification;
        if (!appended) { pi.appendEntry("agent-team:notification", data); notification.appended = true; }
        if (hostMode) {
          if (!hostTransport) return;
          const ack = await hostTransport.post(data);
          if (!ack.accepted) return;
        } else {
          pi.sendMessage({ customType: "agent-team:results-ready", display: false,
            details: { version: 1, notificationId: data.notificationId },
            content: runs.length + " background subagent result(s) are waiting to be collected. Call subagent_wait to read the full result.\\n\\n" + data.text },
            { deliverAs: "followUp", triggerTurn: true });
        }
        backgroundRuns.markNotified(data.runIds);
      } catch {} finally { inflight = false; }
    };
    pi.on("agent_end", report);
\tpi.registerCommand("subagents", {});
`);
    return readFileSync(file, "utf8");
  } finally { rmSync(root, { recursive: true, force: true }); }
}
