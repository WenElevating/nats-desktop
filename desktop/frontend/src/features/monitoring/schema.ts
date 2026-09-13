import { z } from "zod";
import type { MonitorSnapshot } from "../../lib/bindings";

/**
 * Wire-tolerant mirror of Go internal/monitor/types.go MonitorSnapshot — the
 * "monitor:snapshot" event payload. Events cross the Wails bridge as plain
 * JSON and are outside the generated bindings surface (kv:watch 同款), so the
 * parse here is the whitelist: unknown fields are stripped, known fields fall
 * back to the Go zero values on a type mismatch, a payload without the
 * required `servers`/row `name` fields drops (null). CallResult is
 * deliberately absent — snapshots carry no error envelope.
 */
const num = z.number().catch(0);
const str = z.string().catch("");
const bool = z.boolean().catch(false);

export const monitorServerRowSchema = z.object({
  name: z.string(),
  id: str,
  host: str,
  cluster: str,
  domain: str,
  version: str,
  online: bool,
  offline_since_ms: num,
  uptime_seconds: num,
  cpu: num,
  mem_bytes: num,
  cores: num,
  connections: num,
  total_connections: num,
  routes: num,
  gateways: num,
  active_accounts: num,
  slow_consumers: num,
  js_enabled: bool,
  // ""|disabled|meta_leader|voter (Go MonitorServerRow.JsRole); anything else
  // on the wire degrades to "" (rendered as the unknown-role placeholder).
  js_role: z.enum(["", "disabled", "meta_leader", "voter"]).catch(""),
  js_streams: num,
  js_streams_leader: num,
  js_consumers: num,
  js_memory_bytes: num,
  js_store_bytes: num,
  js_max_memory_bytes: num,
  js_max_store_bytes: num,
  error: str,
});

export const monitorSnapshotSchema = z.object({
  servers: z.array(monitorServerRowSchema),
  sys_available: bool,
  sys_reason: str,
  polled_at_ms: num,
  cycle_ms: num,
  rtt_ms: num,
  poll_interval_seconds: num,
});

/** Parse one monitor:snapshot payload; null = malformed, caller drops it. */
export function parseSnapshot(raw: unknown): MonitorSnapshot | null {
  const res = monitorSnapshotSchema.safeParse(raw);
  return res.success ? (res.data as MonitorSnapshot) : null;
}
