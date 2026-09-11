import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Events } from "@wailsio/runtime";
import { ConnSnapshot } from "../lib/bindings";

/**
 * Connection state as consumed by the UI. Mirrors the Go
 * connections.StateEvent payload of the "conn:state" event (spec §7.3), with
 * rtt_ms mapped to camelCase. rttMs === 0 means "not measured" (Task 8 note).
 */
export interface ConnState {
  state: string; // disconnected | connecting | connected | reconnecting | failed
  context: string;
  rttMs: number;
  reason: string;
}

/** Disconnected default; also the fallback for malformed event payloads. */
export const DISCONNECTED: ConnState = {
  state: "disconnected",
  context: "",
  rttMs: 0,
  reason: "",
};

// Wire shape of the Go payload (internal/connections/types.go StateEvent).
interface StateEventWire {
  context?: unknown;
  state?: unknown;
  rtt_ms?: unknown;
  reason?: unknown;
}

function parseEvent(data: unknown): ConnState {
  const d = (data ?? {}) as StateEventWire;
  return {
    state: typeof d.state === "string" ? d.state : DISCONNECTED.state,
    context: typeof d.context === "string" ? d.context : "",
    rttMs: typeof d.rtt_ms === "number" ? d.rtt_ms : 0,
    reason: typeof d.reason === "string" ? d.reason : "",
  };
}

const ConnStateContext = createContext<ConnState>(DISCONNECTED);

/**
 * Subscribes to Wails "conn:state" events and exposes the latest state via
 * useConnState(). Mount once, wrapping the Shell.
 *
 * On mount the state is also hydrated from the ConnSnapshot() binding so
 * transitions that fired before the UI subscribed (e.g. the §6.1 startup
 * restore) are reflected; a live event always wins over a late snapshot.
 */
export function ConnStateProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<ConnState>(DISCONNECTED);
  const gotEvent = useRef(false);

  useEffect(() => {
    const off = Events.On("conn:state", (e) => {
      gotEvent.current = true;
      setConn(parseEvent(e.data));
    });
    ConnSnapshot()
      .then((snap) => {
        if (!gotEvent.current && snap) setConn(parseEvent(snap));
      })
      .catch(() => {
        /* outside Wails (plain browser/tests) — the default stands */
      });
    return () => {
      off();
    };
  }, []);

  return (
    <ConnStateContext.Provider value={conn}>
      {children}
    </ConnStateContext.Provider>
  );
}

export function useConnState(): ConnState {
  return useContext(ConnStateContext);
}
