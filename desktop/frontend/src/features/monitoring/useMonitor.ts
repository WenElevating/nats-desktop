import { useCallback, useEffect, useRef, useState } from "react";
import { Events } from "@wailsio/runtime";
import { useConnState } from "../../app/connstate";
import {
  GetMonitoringSnapshot,
  GetSettings,
  StartMonitoring,
  StopMonitoring,
  type MonitorSnapshot,
} from "../../lib/bindings";
import { parseSnapshot } from "./schema";

/**
 * The useMonitor surface consumed by MonitoringPage (Task 10) and the detail
 * panels landing in Tasks 11-13 (`intervalSeconds` is an additive extension:
 * the toolbar's cadence chip — settings value until the first snapshot
 * reports the Go-clamped effective interval).
 */
export interface MonitorApi {
  /** Latest snapshot (event-pushed or the initial cached read); null until
   * the first frame lands. */
  snapshot: MonitorSnapshot | null;
  /** snapshot.sys_available (false while snapshot is null). */
  sysAvailable: boolean;
  /** snapshot.sys_reason (the degradation banner's expandable 原文). */
  sysReason: string;
  /** Display cadence in seconds (Go clamps 2..60). */
  intervalSeconds: number;
  paused: boolean;
  setPaused: (p: boolean) => void;
  /** Force an immediate cycle by restarting the Go poll loop (its first
   * action is always one runCycle — the "Refresh now" toolbar entry). */
  refreshNow: () => Promise<void>;
  /** Selected server NAME (string | null). */
  selected: string | null;
  setSelected: (name: string | null) => void;
}

/**
 * Frontend state for the Monitoring page (spec §6.10). Unlike the list pages
 * there is no frontend poll loop: StartMonitoring spins up the Go-side loop,
 * which emits "monitor:snapshot" every cycle; the hook only gates the loop's
 * lifetime (§20.2 / brief):
 *
 *   connected + visible + !paused → StartMonitoring (+ immediate first frame
 *   painted from GetMonitoringSnapshot's cache);
 *   hidden / disconnected / paused / unmount → StopMonitoring (Go is
 *   idempotent, and StopMonitoring waits for the goroutine so no stale emit
 *   can follow it).
 *
 * The last frame is kept while merely hidden or paused (repaint on return is
 * instant and the loop is provably stopped) but cleared on disconnect, where
 * stale data must never masquerade as live (useStreams 同款).
 */
export function useMonitor(): MonitorApi {
  const conn = useConnState();
  const connected = conn.state === "connected";

  const [snapshot, setSnapshot] = useState<MonitorSnapshot | null>(null);
  const [intervalSeconds, setIntervalSeconds] = useState(5);
  const [paused, setPausedState] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // §20.2 失焦暂停: visibilitychange gates the Go loop like the frontend ones.
  const [visible, setVisible] = useState(() => document.visibilityState !== "hidden");

  // Live gate values, read by applyGates so any toggle re-evaluates all three
  // without the effect needing to re-bind (and refreshNow can consult them).
  const gates = useRef({ connected: false, visible: true, paused: false });

  // Mirrors useKv's watchClearRef pattern: reassigned every render so it
  // always closes over fresh state, invoked from effects and handlers.
  const applyGates = useRef(async () => {});
  applyGates.current = async () => {
    const g = gates.current;
    if (g.connected && g.visible && !g.paused) {
      try {
        await StartMonitoring();
        // The Go loop emits its first frame immediately; the cached read
        // paints it even if that emit is still in flight. A gate that flips
        // mid-flight voids the answer.
        const parsed = parseSnapshot(await GetMonitoringSnapshot());
        const now = gates.current;
        if (parsed && now.connected && now.visible && !now.paused) {
          if (parsed.poll_interval_seconds > 0) {
            setIntervalSeconds(parsed.poll_interval_seconds);
          }
          setSnapshot(parsed);
        }
      } catch {
        /* transport-level failure: the next gate change re-syncs */
      }
    } else {
      try {
        await StopMonitoring();
      } catch {
        /* idempotent best-effort */
      }
      if (!g.connected) setSnapshot(null);
    }
  };

  useEffect(() => {
    gates.current = { connected, visible, paused };
    void applyGates.current();
  }, [connected, visible, paused]);

  // §20.2 失焦暂停: visibilitychange gates the Go loop like the frontend ones.
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Unmount always stops the server-side loop (page navigated/closed).
  useEffect(() => {
    return () => {
      StopMonitoring().catch(() => {});
    };
  }, []);

  // The event subscription lives for the hook's lifetime; Go guarantees no
  // emit after StopMonitoring returns, so no stale delivery can leak in.
  useEffect(() => {
    const off = Events.On("monitor:snapshot", (e: { data?: unknown }) => {
      const parsed = parseSnapshot(e?.data);
      if (!parsed) return;
      if (parsed.poll_interval_seconds > 0) {
        setIntervalSeconds(parsed.poll_interval_seconds);
      }
      setSnapshot(parsed);
    });
    return () => {
      off();
    };
  }, []);

  // Settings cadence until the first snapshot reports the Go-clamped value.
  useEffect(() => {
    let alive = true;
    GetSettings()
      .then((s) => {
        const secs = s?.behavior?.poll_interval_seconds ?? 0;
        if (alive && secs > 0) setIntervalSeconds(secs);
      })
      .catch(() => {
        /* default cadence stands */
      });
    return () => {
      alive = false;
    };
  }, []);

  const setPaused = useCallback((p: boolean) => setPausedState(p), []);

  const refreshNow = useCallback(async () => {
    const g = gates.current;
    if (!g.connected || !g.visible || g.paused) return;
    try {
      // Stop first (waits for the goroutine), then start: pollLoop's first
      // action is one immediate cycle, so the next monitor:snapshot is a
      // fresh frame rather than the cache.
      await StopMonitoring();
      await StartMonitoring();
    } catch {
      /* the next gate change re-syncs */
    }
  }, []);

  const setSelectedName = useCallback((name: string | null) => setSelected(name), []);

  return {
    snapshot,
    sysAvailable: snapshot?.sys_available ?? false,
    sysReason: snapshot?.sys_reason ?? "",
    intervalSeconds,
    paused,
    setPaused,
    refreshNow,
    selected,
    setSelected: setSelectedName,
  };
}
