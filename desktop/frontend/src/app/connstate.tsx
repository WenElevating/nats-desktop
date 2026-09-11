import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Events } from "@wailsio/runtime";

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
 * Task 10 seam: once the connections service is registered, hydrate the
 * initial value from the ConnSnapshot() binding here; until then the
 * disconnected default is authoritative and events drive everything.
 */
export function ConnStateProvider({ children }: { children: ReactNode }) {
  const [conn, setConn] = useState<ConnState>(DISCONNECTED);

  useEffect(() => {
    const off = Events.On("conn:state", (e) => setConn(parseEvent(e.data)));
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
