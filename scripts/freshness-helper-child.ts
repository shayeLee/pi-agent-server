#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseFreshnessRequest, updateFreshness } from "../src/drill/drill-freshness.js";

try {
  const request = parseFreshnessRequest(JSON.parse(readFileSync(0, "utf8")));
  process.stdout.write(JSON.stringify(updateFreshness(request)));
} catch {
  // Never echo the request: it contains absolute paths and may contain a report.
  process.stdout.write(JSON.stringify({ ok: false, updated: false, staleLockReclaimed: false, detail: "freshness helper request failed" }));
  process.exitCode = 1;
}
