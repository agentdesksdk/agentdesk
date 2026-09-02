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
  type DirectCapabilitySpec,
  type DistributiveOmit,
  type StagedCapabilitySpec,
  type CapabilityRelationships,
  type NormalizedRelationships,
  type Change,
  type ExecutionContext,
  type InputSchema,
  type Policy,
  type Presentation,
  type RiskLevel,
  type ToolSurfaceKind,
  type Unavailability,
} from "./capability.ts";
export { CapabilityCatalog } from "./catalog.ts";
export {
  StagedCommitIndeterminate,
  StagedCommitRefused,
  StagedProposalError,
  StagedProposalStore,
  type StagedProposal,
  type StagedResolution,
  type StagingAdapter,
  type Unreconciled,
} from "./staging.ts";
export {
  highestRisk,
  isHumanActor,
  parseActor,
  type Actor,
  type HumanActor,
  type OperationOutcome,
  type OperationPlan,
  type PlanId,
  type PlannedOperation,
  type PlanStatus,
  type VerificationResult,
} from "./plan.ts";
export {
  type ReceiptQuery,
  type ReconciliationOutcome,
  type RollbackState,
  type StoredReceipt,
} from "./receipts.ts";
export {
  type FocusPolicy,
  type PresentationEvent,
  type PresentationListener,
  type PresentationPhase,
} from "./presentation.ts";
export { availableCapabilities, evaluateAvailability } from "./availability.ts";
export {
  rankCapabilities,
  routeTask,
  tokenize,
  RELATION_WEIGHTS,
  ROUTING_WEIGHTS,
  type CapabilityScorer,
  type RankedCapability,
  type RoutingRequest,
  type RoutingRequestSnapshot,
  type RoutingDescriptor,
  type RoutingResult,
  type RoutingStrategy,
  type RoutingStrategyKind,
  type ScoredCapability,
  type ScoredDescriptor,
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
  assertSafeOrigins,
  createWebMcpAdapter,
  getModelContext,
  probeFeatures,
  type ModelContextLike,
  type NativeToolDefinition,
  type RegisteredTool,
  type RegisterToolFn,
  type RegisterToolOptions,
  type WebMcpAdapter,
  type WebMcpFeatures,
} from "./webmcp-adapter.ts";
export {
  createWebMcpClient,
  readInputSchema,
  type InputEncoding,
  type NegotiationRequest,
  type WebMcpClient,
  type WebMcpClientOptions,
} from "./client.ts";
export {
  defaultValidator,
  unsupportedSchemaKeywords,
  type ValidationIssue,
  type ValidationResult,
  type Validator,
} from "./validation.ts";
export {
  decidePolicy,
  riskBasedPolicy,
  type PolicyDecision,
  type PolicyEngine,
  type PolicyRequest,
} from "./policy.ts";
export {
  toObservabilityEvent,
  OBSERVABILITY_SCHEMA_VERSION,
  type ObservabilityEvent,
  type ObservabilityExporter,
} from "./observability.ts";
export {
  type ActionRecord,
  type ActionStatus,
  type PendingAction,
} from "./approval.ts";
export type { AuditEvent, AuditListener } from "./audit.ts";
export { GrantStore, matchesScope, parseGrantRequest, parseScope } from "./grants.ts";
export type {
  Grant,
  GrantConsultation,
  GrantId,
  GrantRefusalCode,
  GrantRequest,
  GrantState,
  LiveGrant,
  ParsedGrantRequest,
  ScopeRule,
  ScopeValue,
} from "./grants.ts";
export type {
  Evidence,
  Refusal,
  RefusalStatus,
  Repair,
  ResultProtocol,
  Settled,
  Situation,
} from "./protocol.ts";
export type { ToolResult, ToolCode } from "./results.ts";
export {
  approvalRequired,
  capabilityUnavailable,
  completed,
  executionCancelled,
  grantRefused,
  idempotencyCapacity,
  idempotencyConflict,
  isReceiptEnvelope,
  policyDenied,
  previewUnavailable,
  receipt,
  toolRetired,
  validationFailed,
  type AffectedObject,
  type Receipt,
} from "./results.ts";
