// Single import surface for the Wails-generated bindings and Go model types.
// The generated tree under frontend/bindings/ is committed (CI does not
// regenerate); this module is the only place app code imports it from, so the
// deep generated paths stay out of feature code.
//
// Regenerate with: wails3 generate bindings -ts -clean=true (from desktop/).

import type { Settings } from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/settings/models.js";

export { GetSettings, SaveSettings } from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/settings/service.js";
export type { Appearance, Behavior, Privacy, Settings } from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/settings/models.js";
export { OpenLogsDir } from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/logging/service.js";
export { CheckUpdate } from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/version/service.js";
export {
  CheckConnection,
  ConnSnapshot,
  Connect,
  CopyContext,
  DeleteContext,
  Disconnect,
  EnvWarnings,
  GetContextForm,
  ListContexts,
  SaveContext,
} from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/connections/service.js";
export type {
  ContextForm,
  ContextSummary,
  StateEvent,
  TestResult,
} from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/connections/models.js";
export {
  ClearSession,
  CloseSession,
  CreateSession,
  ListSessions,
  PauseSession,
  Publish,
  Request,
  ResumeSession,
  Trace,
} from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/messaging/messagingservice.js";
// PushMode is a value export (a real TS enum): the create form must send one
// of its members and never the $zero "" Go zero value.
export { PushMode } from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/messaging/models.js";
export type {
  JSPosition,
  PubForm,
  PubResult,
  ReqForm,
  ReqResult,
  SessionSpec,
  SessionState,
  TraceForm,
  TraceHop,
} from "../../bindings/github.com/WenElevating/nats-desktop/desktop/internal/messaging/models.js";

// Default mirrors settings.Default() in internal/settings/settings.go.
// Keep the field values in sync with the Go side.
export function Default(): Settings {
  return {
    appearance: {
      theme: "system",
      language: "en",
    },
    behavior: {
      poll_interval_seconds: 5,
      request_timeout_seconds: 5,
      confirm_level: "standard",
      session_push_batching: false,
      session_buffer_size: 10000,
      log_level: "info",
    },
    privacy: {
      crash_reports: false,
      update_check: true,
    },
    last_active_context: "",
  };
}
