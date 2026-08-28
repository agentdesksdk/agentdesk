export {
  AVAILABLE,
  CapabilityUnavailableError,
  defineCapability,
  parseCapabilityName,
  unavailable,
  type AppContext,
  type Availability,
  type Capability,
  type CapabilityName,
  type CapabilitySpec,
  type InputSchema,
  type Policy,
  type RiskLevel,
  type ToolSurfaceKind,
  type Unavailability,
} from "./capability.ts";
export { CapabilityCatalog } from "./catalog.ts";
export { availableCapabilities, evaluateAvailability } from "./availability.ts";
export {
  rankCapabilities,
  tokenize,
  ROUTING_WEIGHTS,
  type RankedCapability,
} from "./router.ts";
export {
  createAgentDeskRuntime,
  type AgentDeskRuntime,
  type Exposure,
  type RoutedMatch,
  type RoutingReport,
  type RuntimeSnapshot,
} from "./runtime.ts";
export {
  createWebMcpAdapter,
  type NativeToolDefinition,
  type RegisterToolFn,
  type WebMcpAdapter,
} from "./webmcp-adapter.ts";
export {
  type ActionRecord,
  type ActionStatus,
  type PendingAction,
} from "./approval.ts";
export type { AuditEvent } from "./audit.ts";
export type { ToolResult, ToolCode } from "./results.ts";
export {
  approvalRequired,
  capabilityUnavailable,
  toolRetired,
} from "./results.ts";
