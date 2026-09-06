/**
 * Monitoring stack manager for the backup-freshness drill (real isolation).
 *
 * Starts a fully isolated, prefixed Podman monitoring stack:
 *   node_exporter (textfile collector)  ->  Prometheus  ->  Alertmanager  ->  webhook
 *   + a control-plane endpoint that exposes `pi_agent_server_backup_expected_target_info`
 *     so an exporter-down event can still be detected (the expected inventory must NOT
 *     come from the watched target itself).
 *
 * Configs are generated fresh into `$DRILL_ROOT/monitor/` on every run. All resources
 * use the `pi-agent-server-disaster-recovery-drill-` prefix. The module only touches
 * those resources, never formal data/backup/staging/auth/PG/receiver.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { DRILL_RESOURCE_PREFIX } from "./drill-constants.js";

const NODE_EXPORTER_IMAGE = process.env.PI_DRILL_NODE_EXPORTER_IMAGE || "docker.io/prom/node-exporter:v1.9.1";
const PROMETHEUS_IMAGE = process.env.PI_DRILL_PROMETHEUS_IMAGE || "docker.io/prom/prometheus:v3.5.0";
const ALERTMANAGER_IMAGE = process.env.PI_DRILL_ALERTMANAGER_IMAGE || "docker.io/prom/alertmanager:v0.28.1";
const NODE_IMAGE = process.env.PI_DRILL_NODE_IMAGE || "docker.io/library/node:24.19-bookworm";

export interface MonitorStackConfig {
  readonly root: string;
  /** Per-run resource namespace; never reuse or delete another run's resources. */
  readonly resourcePrefix?: string;
  readonly network?: string;
  /** Logical backup target id (e.g. "drill-sqlite"). */
  readonly target: string;
  /** Stale threshold in seconds used by the short-fuse drill rule. */
  readonly staleSec?: number;
  /** Future skew tolerance in seconds used by the drill rule. */
  readonly futureSkewSec?: number;
  readonly alertFor?: string;
  readonly scrapeInterval?: string;
  readonly evaluationInterval?: string;
}

export interface MonitorState {
  readonly cfg: MonitorStackConfig;
  readonly nodeExporter: string;
  readonly prometheus: string;
  readonly alertmanager: string;
  readonly webhook: string;
  readonly textfileDir: string;
  readonly monitorDir: string;
  readonly webhookRecordDir: string;
  readonly expectedPromFile: string;
  readonly nodeExporterPort: number;
  readonly prometheusPort: number;
  readonly alertmanagerPort: number;
  readonly webhookPort: number;
  /** IDs captured immediately after creation; names alone are never enough for cleanup. */
  readonly containerIds: { nodeExporter?: string; webhook?: string; alertmanager?: string; prometheus?: string };
  started: boolean;
}

function podman(args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("podman", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) return { status: -1, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        const port = typeof address === "object" && address !== null ? address.port : 0;
        if (port === 0) reject(new Error("could not allocate a free host port"));
        else resolve(port);
      });
    });
  });
}

/** The generated node webhook + control-plane server. */
export function renderWebhookServer(): string {
  return `#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const RECORD_DIR = process.env.DRILL_WEBHOOK_RECORD_DIR || '/record';
const EXPECTED_FILE = process.env.DRILL_EXPECTED_PROM_FILE || '/expected.prom';
const WEBHOOK_PORT = Number(process.env.DRILL_WEBHOOK_PORT || 8080);
const EXPECTED_PORT = Number(process.env.DRILL_EXPECTED_PORT || 9101);
fs.mkdirSync(RECORD_DIR, { recursive: true });
const recordFile = path.join(RECORD_DIR, 'alerts.jsonl');
function append(record) {
  fs.appendFileSync(recordFile, JSON.stringify(record) + '\\n');
}
http.createServer((req, res) => {
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const status = data.status;
        for (const a of (data.alerts || [])) {
          append({ status, alertname: a.labels?.alertname, severity: a.labels?.severity, startsAt: a.startsAt, endsAt: a.endsAt });
        }
        res.writeHead(200); res.end('{"ok":true}');
      } catch (e) { res.writeHead(400); res.end(String(e)); }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/record') {
    let data = '';
    try { data = fs.readFileSync(recordFile, 'utf8'); } catch {}
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data.split('\\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
}).listen(WEBHOOK_PORT, '0.0.0.0');
http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/metrics') {
    let body = '';
    try { body = fs.readFileSync(EXPECTED_FILE, 'utf8'); } catch (e) { body = ''; }
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(body);
    return;
  }
  res.writeHead(404); res.end();
}).listen(EXPECTED_PORT, '0.0.0.0');
`;
}

/** Render the expected_target_info prometheus text for a single drill target. */
function expectedPromText(target: string): string {
  return `# HELP pi_agent_server_backup_expected_target_info Expected backup target.\n# TYPE pi_agent_server_backup_expected_target_info gauge\npi_agent_server_backup_expected_target_info{target="${target}"} 1\n`;
}

function renderPrometheusConfig(cfg: MonitorStackConfig, name: { nodeExporter: string; webhook: string; alertmanager: string }): string {
  const stale = cfg.staleSec ?? 100;
  const future = cfg.futureSkewSec ?? 300;
  const forDur = cfg.alertFor ?? "2s";
  const scrape = cfg.scrapeInterval ?? "2s";
  const evalInterval = cfg.evaluationInterval ?? "2s";
  return `global:
  scrape_interval: ${scrape}
  scrape_timeout: 1s
  evaluation_interval: ${evalInterval}
rule_files:
  - /etc/prometheus/rules.yml
alerting:
  alertmanagers:
    - static_configs:
        - targets: ['${name.alertmanager}:9093']
scrape_configs:
  - job_name: backup-targets
    static_configs:
      - targets: ['${name.nodeExporter}:9100']
    relabel_configs:
      - source_labels: [__address__]
        target_label: instance
        replacement: drill-1
      - source_labels: [__address__]
        target_label: cluster
        replacement: drill
  - job_name: control-plane
    static_configs:
      - targets: ['${name.webhook}:9101']
    metric_relabel_configs:
      - action: drop
        source_labels: [__name__]
        regex: ^up$
      - source_labels: [__address__]
        target_label: instance
        replacement: drill-1
      - source_labels: [__address__]
        target_label: cluster
        replacement: drill
      - source_labels: [__address__]
        target_label: job
        replacement: backup-targets
`;
}

function renderRules(cfg: MonitorStackConfig): string {
  const stale = cfg.staleSec ?? 100;
  const future = cfg.futureSkewSec ?? 300;
  const forDur = cfg.alertFor ?? "2s";
  return `groups:
  - name: pi-agent-server-backup
    rules:
      - alert: PiAgentServerBackupExporterDown
        expr: (pi_agent_server_backup_expected_target_info == 1) unless on (job, instance, cluster) (up == 1)
        for: ${forDur}
        labels:
          severity: critical
      - alert: PiAgentServerBackupTextfileScrapeError
        expr: (pi_agent_server_backup_expected_target_info == 1) and on (job, instance, cluster) (node_textfile_scrape_error == 1)
        for: ${forDur}
        labels:
          severity: critical
      - alert: PiAgentServerBackupFreshnessMissing
        expr: ((pi_agent_server_backup_expected_target_info == 1) and on (job, instance, cluster) (up == 1)) unless on (job, instance, cluster) (pi_agent_server_backup_last_success_timestamp_seconds)
        for: ${forDur}
        labels:
          severity: critical
      - alert: PiAgentServerBackupStale
        expr: (time() - pi_agent_server_backup_last_success_timestamp_seconds > ${stale}) and on (job, instance, cluster) (pi_agent_server_backup_expected_target_info == 1)
        for: ${forDur}
        labels:
          severity: critical
      - alert: PiAgentServerBackupFutureTimestamp
        expr: (pi_agent_server_backup_last_success_timestamp_seconds > time() + ${future}) and on (job, instance, cluster) (pi_agent_server_backup_expected_target_info == 1)
        for: ${forDur}
        labels:
          severity: critical
`;
}

function renderAlertmanagerConfig(webhookName: string): string {
  return `global:
  resolve_timeout: 5m
route:
  receiver: drill-webhook
  group_by: ['alertname']
  group_wait: 0s
  group_interval: 1s
  repeat_interval: 4s
receivers:
  - name: drill-webhook
    webhook_configs:
      - url: 'http://${webhookName}:8080/'
        send_resolved: true
`;
}

/** Write all monitoring configs + support scripts into the monitor dir. Returns full state (not yet started). */
export async function prepareMonitorStack(cfg: MonitorStackConfig): Promise<MonitorState> {
  const monitorDir = path.join(cfg.root, "monitor");
  const textfileDir = path.join(cfg.root, "textfile");
  const webhookRecordDir = path.join(cfg.root, "monitor", "record");
  const expectedPromFile = path.join(monitorDir, "expected.prom");
  for (const dir of [monitorDir, textfileDir, webhookRecordDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const prefix = cfg.resourcePrefix ?? DRILL_RESOURCE_PREFIX;
  const nodeExporter = `${prefix}node-exporter`;
  const prometheus = `${prefix}prometheus`;
  const alertmanager = `${prefix}alertmanager`;
  const webhook = `${prefix}webhook`;
  writeFileSync(path.join(monitorDir, "webhook-server.mjs"), renderWebhookServer(), { mode: 0o600 });
  writeFileSync(path.join(monitorDir, "prometheus.yml"), renderPrometheusConfig(cfg, { nodeExporter, webhook, alertmanager }), { mode: 0o600 });
  writeFileSync(path.join(monitorDir, "rules.yml"), renderRules(cfg), { mode: 0o600 });
  writeFileSync(path.join(monitorDir, "alertmanager.yml"), renderAlertmanagerConfig(webhook), { mode: 0o600 });
  writeFileSync(expectedPromFile, expectedPromText(cfg.target), { mode: 0o600 });
  return {
    cfg,
    nodeExporter,
    prometheus,
    alertmanager,
    webhook,
    textfileDir,
    monitorDir,
    webhookRecordDir,
    expectedPromFile,
    nodeExporterPort: await freePort(),
    prometheusPort: await freePort(),
    alertmanagerPort: await freePort(),
    webhookPort: await freePort(),
    containerIds: {},
    started: false,
  };
}

function containerExists(name: string): boolean {
  const result = podman(["container", "exists", name]);
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error("monitor container existence check failed");
}

function containerId(name: string): string | null {
  if (!containerExists(name)) return null;
  const result = podman(["container", "inspect", "-f", "{{.Id}}", name]);
  if (result.status !== 0 || !result.stdout.trim()) throw new Error("monitor container identity check failed");
  return result.stdout.trim();
}

function containerLabel(name: string): string {
  if (!containerExists(name)) return "";
  const result = podman(["container", "inspect", "-f", '{{index .Config.Labels "pi-agent-server.drill.run"}}', name]);
  if (result.status !== 0) throw new Error("monitor container label check failed");
  return result.stdout.trim();
}

function rmContainer(name: string, expectedId: string): void {
  const actual = containerId(name);
  if (actual === null) return;
  if (actual !== expectedId) throw new Error("monitor resource ownership changed");
  if (podman(["rm", "-f", name]).status !== 0 || containerExists(name)) throw new Error("monitor container cleanup failed");
}

function rmContainerByLabel(name: string, expectedLabel: string): void {
  if (!containerExists(name)) return;
  if (containerLabel(name) !== expectedLabel) throw new Error("monitor resource label mismatch");
  if (podman(["rm", "-f", name]).status !== 0 || containerExists(name)) throw new Error("monitor container cleanup failed");
}

async function waitHttp(url: string, attempts = 40, intervalMs = 500): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    const result = spawnSync("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", url], { encoding: "utf8", timeout: 4000 });
    if (result.status === 0 && result.stdout === "200") return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

/** Start the monitoring stack (all prefixed resources). Throws on any config/start failure. */
export async function startMonitorStack(state: MonitorState): Promise<void> {
  const c = state.cfg;
  const webhookServer = path.join(state.monitorDir, "webhook-server.mjs");
  const created: Array<keyof MonitorState["containerIds"]> = [];
  const cleanupPartial = (): void => {
    const names: Record<string, string> = { nodeExporter: state.nodeExporter, webhook: state.webhook, alertmanager: state.alertmanager, prometheus: state.prometheus };
    for (const key of created.reverse()) {
      const id = state.containerIds[key];
      try { id ? rmContainer(names[key]!, id) : rmContainerByLabel(names[key]!, state.cfg.resourcePrefix ?? DRILL_RESOURCE_PREFIX); } catch { /* preserve original startup failure */ }
    }
  };
  try { await startMonitorStackInner(state, created); }
  catch (error) { cleanupPartial(); throw error; }
}

async function startMonitorStackInner(state: MonitorState, created: Array<keyof MonitorState["containerIds"]>): Promise<void> {
  const c = state.cfg;
  const webhookServer = path.join(state.monitorDir, "webhook-server.mjs");
  const network = state.cfg.network ?? `${state.cfg.resourcePrefix ?? DRILL_RESOURCE_PREFIX}net`;
  for (const name of [state.prometheus, state.alertmanager, state.webhook, state.nodeExporter]) {
    if (podman(["container", "exists", name]).status === 0) throw new Error("monitor resource collision");
  }
  // node_exporter (textfile collector; textfile dir shared rw for fault injection).
  let r = podman([
    "run", "-d", "--name", state.nodeExporter, "--network", network,
    "--label", `pi-agent-server.drill.run=${state.cfg.resourcePrefix ?? DRILL_RESOURCE_PREFIX}`,
    "-v", `${state.textfileDir}:/textfile:rw`, "-p", `127.0.0.1:${state.nodeExporterPort}:9100`,
    NODE_EXPORTER_IMAGE, "--collector.textfile.directory=/textfile",
  ]);
  if (r.status !== 0) throw new Error(`node-exporter start failed: ${r.stderr}`);
  created.push("nodeExporter");
  state.containerIds.nodeExporter = containerId(state.nodeExporter) ?? undefined;
  if (!state.containerIds.nodeExporter) throw new Error("node-exporter identity unavailable");
  // webhook + control-plane (node container).
  r = podman([
    "run", "-d", "--name", state.webhook, "--network", network,
    "--label", `pi-agent-server.drill.run=${state.cfg.resourcePrefix ?? DRILL_RESOURCE_PREFIX}`,
    "-v", `${state.monitorDir}/webhook-server.mjs:/webhook-server.mjs:ro`,
    "-v", `${state.webhookRecordDir}:/record:rw`,
    "-v", `${state.expectedPromFile}:/expected.prom:ro`,
    "-e", "DRILL_WEBHOOK_RECORD_DIR=/record", "-e", "DRILL_EXPECTED_PROM_FILE=/expected.prom",
    "-e", "DRILL_WEBHOOK_PORT=8080", "-e", "DRILL_EXPECTED_PORT=9101",
    "-p", `127.0.0.1:${state.webhookPort}:8080`,
    NODE_IMAGE, "node", "/webhook-server.mjs",
  ]);
  if (r.status !== 0) throw new Error(`webhook start failed: ${r.stderr}`);
  created.push("webhook");
  state.containerIds.webhook = containerId(state.webhook) ?? undefined;
  if (!state.containerIds.webhook) throw new Error("webhook identity unavailable");
  // Alertmanager.
  r = podman([
    "run", "-d", "--name", state.alertmanager, "--network", network,
    "--label", `pi-agent-server.drill.run=${state.cfg.resourcePrefix ?? DRILL_RESOURCE_PREFIX}`,
    "-v", `${state.monitorDir}/alertmanager.yml:/alertmanager.yml:ro`,
    "-p", `127.0.0.1:${state.alertmanagerPort}:9093`,
    ALERTMANAGER_IMAGE, "--config.file=/alertmanager.yml",
  ]);
  if (r.status !== 0) throw new Error(`alertmanager start failed: ${r.stderr}`);
  created.push("alertmanager");
  state.containerIds.alertmanager = containerId(state.alertmanager) ?? undefined;
  if (!state.containerIds.alertmanager) throw new Error("alertmanager identity unavailable");
  // Prometheus.
  const promDataDir = path.join(state.monitorDir, "prom-data");
  mkdirSync(promDataDir, { recursive: true, mode: 0o700 });
  r = podman([
    "run", "-d", "--name", state.prometheus, "--network", network,
    "--label", `pi-agent-server.drill.run=${state.cfg.resourcePrefix ?? DRILL_RESOURCE_PREFIX}`,
    "-v", `${state.monitorDir}:/etc/prometheus:ro`, "-v", `${promDataDir}:/prometheus:rw`,
    "-p", `127.0.0.1:${state.prometheusPort}:9090`,
    PROMETHEUS_IMAGE, "--config.file=/etc/prometheus/prometheus.yml", "--storage.tsdb.path=/prometheus/data", "--web.enable-lifecycle",
  ]);
  if (r.status !== 0) throw new Error(`prometheus start failed: ${r.stderr}`);
  created.push("prometheus");
  state.containerIds.prometheus = containerId(state.prometheus) ?? undefined;
  if (!state.containerIds.prometheus) throw new Error("prometheus identity unavailable");
  // Readiness waits.
  if (!(await waitHttp(`http://127.0.0.1:${state.nodeExporterPort}/metrics`))) throw new Error("node-exporter did not become ready");
  if (!(await waitHttp(`http://127.0.0.1:${state.webhookPort}/`))) throw new Error("webhook did not become ready");
  if (!(await waitHttp(`http://127.0.0.1:${state.alertmanagerPort}/-/ready`))) throw new Error("alertmanager did not become ready");
  if (!(await waitHttp(`http://127.0.0.1:${state.prometheusPort}/-/ready`))) throw new Error("prometheus did not become ready");
  state.started = true;
}

/** Stop/remove only this run's monitoring containers. */
export async function stopMonitorStack(state: MonitorState): Promise<void> {
  const failures: string[] = [];
  const resources: Array<[string, string | undefined]> = [
    [state.prometheus, state.containerIds.prometheus],
    [state.alertmanager, state.containerIds.alertmanager],
    [state.webhook, state.containerIds.webhook],
    [state.nodeExporter, state.containerIds.nodeExporter],
  ];
  for (const [name, id] of resources) {
    try {
      if (!id) throw new Error("monitor container identity unavailable");
      rmContainer(name, id);
    } catch {
      failures.push("container");
    }
  }
  if (failures.length > 0) throw new Error("monitor container cleanup failed");
  state.started = false;
}

export function prometheusReady(state: MonitorState): boolean {
  return existsSync(state.monitorDir);
}

export function prometheusQuery(state: MonitorState, query: string): string {
  const encoded = encodeURIComponent(query);
  const result = spawnSync("curl", ["-s", `http://127.0.0.1:${state.prometheusPort}/api/v1/query?query=${encoded}`], { encoding: "utf8", timeout: 8000 });
  return result.stdout || "";
}

export function prometheusAlertsJson(state: MonitorState): string {
  const result = spawnSync("curl", ["-s", `http://127.0.0.1:${state.prometheusPort}/api/v1/alerts`], { encoding: "utf8", timeout: 8000 });
  return result.stdout || "";
}

export function prometheusReload(state: MonitorState): void {
  podman(["exec", state.prometheus, "wget", "-qO-", "--post-data=", "http://127.0.0.1:9090/-/reload"]);
}

function webhookRecords(state: MonitorState): Array<{ status?: string; alertname?: string }> {
  const recordFile = path.join(state.webhookRecordDir, "alerts.jsonl");
  if (!existsSync(recordFile)) return [];
  return readFileSync(recordFile, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line) as { status?: string; alertname?: string }]; } catch { return []; }
  });
}

/** Remove the previous alert runtime generation before a new guard cycle. */
export function resetWebhookRecords(state: MonitorState): void {
  rmSync(path.join(state.webhookRecordDir, "alerts.jsonl"), { force: true });
}

export function webhookRecordCount(state: MonitorState): number {
  return webhookRecords(state).length;
}

export function webhookSeenSince(state: MonitorState, alertname: string, checkpoint: number, wanted: "firing" | "resolved"): boolean {
  return webhookRecords(state).slice(checkpoint).some((record) => record.alertname === alertname && record.status === wanted);
}

export function webhookSeen(state: MonitorState, alertname: string): { firing: boolean; resolved: boolean } {
  const records = webhookRecords(state);
  return {
    firing: records.some((record) => record.alertname === alertname && record.status === "firing"),
    resolved: records.some((record) => record.alertname === alertname && record.status === "resolved"),
  };
}

export function isAlertActual(state: MonitorState, alertname: string): boolean {
  const alertsJson = prometheusAlertsJson(state);
  return alertsJson.includes(`"alertname":"${alertname}"`);
}
