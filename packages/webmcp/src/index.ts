export {
  AVAILABLE,
  CapabilityUnavailableError,
  defineCapability,
  parseCapabilityName,
  unavailable,
  type AgentView,
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
  nativeProvider,
  type CapabilityProvider,
  type NativeProviderOptions,
} from "./provider.ts";
export {
  catalogHierarchy,
  hierarchicalScorer,
  hierarchicalScorerWith,
  NEAR_TIE,
  type CatalogDomain,
  type CatalogHierarchy,
  type CatalogSubdomain,
  type CatalogTree,
  type HierarchyMember,
} from "./hierarchy.ts";
export {
  digestOf,
  stateDigest,
  StagedCommitIndeterminate,
  StagedCommitRefused,
  StagedProposalError,
  StagedProposalStore,
  type Forked,
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
  type PresentationRequest,
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
export {
  indexedDbPersistence,
  memoryPersistence,
  sealOf,
  verifyRecord,
  type IndexedDbLike,
  type IndexedDbPersistenceOptions,
  type PersistedArtifact,
  type PersistedIdempotencyClaim,
  type PersistedRecord,
  type PersistenceAdapter,
} from "./persistence.ts";
export {
  indexedDbStaging,
  type IndexedDbBaseRow,
  type IndexedDbDraft,
  type IndexedDbFork,
  type IndexedDbHeadRow,
  type IndexedDbOperation,
  type IndexedDbRow,
  type IndexedDbStagingAdapter,
  type IndexedDbStagingOptions,
} from "./indexeddb-staging.ts";
export {
  restStaging,
  RestCommitPartial,
  type RestAcknowledged,
  type RestBaseRow,
  type RestDraft,
  type RestFork,
  type RestHeadRow,
  type RestOperation,
  type RestResource,
  type RestRow,
  type RestRowRef,
  type RestStagingAdapter,
  type RestStagingOptions,
  type RestVersionSource,
} from "./rest-staging.ts";
export {
  GESTURE_TTL_MS,
  GestureStore,
  isApprovalGesture,
  type ApprovalGesture,
  type GestureBinding,
  type GestureVerdict,
} from "./gesture.ts";
export { GrantStore, matchesScope, parseGrantRequest, parseScope } from "./grants.ts";
export type {
  Grant,
  GrantConsultation,
  GrantId,
  GrantOutcome,
  ConsideredGrant,
  ScopeOutcome,
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
  approvalStale,
  capabilityUnavailable,
  completed,
  executionCancelled,
  idempotencyCapacity,
  idempotencyConflict,
  isReceiptEnvelope,
  policyDenied,
  previewUnavailable,
  receipt,
  toolRetired,
  validationFailed,
  viewUnavailable,
  type AffectedObject,
  type AuthoredEvidenceLink,
  type EvidenceLink,
  type Receipt,
} from "./results.ts";
