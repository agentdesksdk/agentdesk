/**
 * Compile-time only. `pnpm typecheck` fails if MCP-B 5.1 drifts from what
 * AgentDesk claims to accept from it.
 *
 * The normative contract stays `webmcp-spec-conformance.ts`. This file is the
 * compatibility lane: it imports the exact MCP-B types the dev dependency
 * pins, checks the consumer and Chromium-extension surfaces AgentDesk says it
 * supports, and records the places MCP-B currently disagrees with the
 * specification. Those records are deliberately falsifiable, so an MCP-B fix
 * produces a compile failure that sends someone back here rather than
 * silently moving the boundary.
 */
import type {
  ChromeModelContextExecuteToolOptions,
  ChromeModelContextExtensions,
  ModelContext as McpBModelContext,
  ModelContextRegisterToolOptions as McpBRegisterToolOptions,
  ModelContextTool as McpBModelContextTool,
  RegisteredTool as McpBRegisteredTool,
} from "@mcp-b/webmcp-types";
import type {
  ModelContextLike,
  RegisteredTool,
  RegisterToolOptions,
} from "../src/webmcp-adapter.ts";

type Conforms<From, To> = [From] extends [To] ? true : never;
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
/** Fails to compile the moment `From` becomes assignable to `To`. */
type StillDiverges<From, To> = [From] extends [To] ? never : true;

/**
 * Values MCP-B hands back have to fit the shapes AgentDesk reads them
 * through, so a browser or polyfill following MCP-B's types cannot produce a
 * tool this SDK mistypes.
 */
export const mcpBRegisteredToolFits: Conforms<
  McpBRegisteredTool,
  RegisteredTool
> = true;
export const mcpBGetToolsFits: Conforms<
  McpBModelContext["getTools"],
  NonNullable<ModelContextLike["getTools"]>
> = true;
export const mcpBModelContextIsAnEventTarget: Conforms<
  McpBModelContext,
  EventTarget
> = true;

/** Options AgentDesk passes to `registerTool` must be legal MCP-B inputs. */
export const registerOptionsAreAccepted: Conforms<
  RegisterToolOptions,
  McpBRegisterToolOptions
> = true;

/**
 * `window` is the member AgentDesk's projection used to omit. Keeping it
 * readable means a consumer filtering by `fromOrigins` can reach the owning
 * window without casting away the type.
 */
export const windowIsReadable: Conforms<
  McpBRegisteredTool["window"],
  NonNullable<RegisteredTool["window"]>
> = true;

/**
 * Both `inputSchema` generations must survive the round trip, because a
 * consumer sees whichever one its browser is old enough to send.
 */
export const bothSchemaArmsFit: Conforms<
  McpBRegisteredTool["inputSchema"],
  RegisteredTool["inputSchema"]
> = true;

/**
 * The Chromium `executeTool` extension, which is what `callTool` drives.
 *
 * Checking only the return type would let a change to the tool argument, the
 * input encoding, or the abort options pass unnoticed, so every position is
 * pinned separately and the intentional difference is named rather than
 * averaged away.
 */
type McpBExecuteTool = NonNullable<ChromeModelContextExtensions["executeTool"]>;
type OurExecuteTool = NonNullable<ModelContextLike["executeTool"]>;
type McpBExecuteParams = Parameters<McpBExecuteTool>;
type OurExecuteParams = Parameters<OurExecuteTool>;

/** It resolves `null` for a tool with no textual output. */
export const executeToolResultFits: Conforms<
  Awaited<ReturnType<McpBExecuteTool>>,
  Awaited<ReturnType<OurExecuteTool>>
> = true;

/**
 * Three positions on each side, so adding or dropping one is visible. The
 * unions are what optional trailing parameters produce.
 *
 * MCP-B requires the input argument; AgentDesk's is optional because
 * `callTool` defaults it to `{}` for a tool that takes none. That is the
 * second intentional widening, alongside the encoding below.
 */
export const executeToolArity: Equals<McpBExecuteParams["length"], 2 | 3> = true;
export const ourExecuteToolArity: Equals<
  OurExecuteParams["length"],
  1 | 2 | 3
> = true;

/**
 * The descriptor position. Values come from `getTools`, so what matters is
 * that MCP-B's fits where AgentDesk reads it.
 */
export const executeToolTakesTheirTool: Conforms<
  McpBExecuteParams[0],
  OurExecuteParams[0]
> = true;

/**
 * Not the other way round, and deliberately so. AgentDesk's `RegisteredTool`
 * is a projection whose `window` is optional, so a hand-built descriptor is
 * legal here and would not satisfy MCP-B, whose `window` is required. Every
 * descriptor AgentDesk actually forwards came from the browser and carries
 * one. This stops compiling if the projection tightens, which is when the
 * note should go.
 */
export const ourToolStaysLooser: StillDiverges<
  OurExecuteParams[0],
  McpBExecuteParams[0]
> = true;

/**
 * The one intentional widening. MCP-B types the payload as `string`, which is
 * what Chrome 152 requires and what `callTool` sends by default. AgentDesk
 * accepts `object | string` because `negotiateEncoding` can settle on the
 * object encoding against a browser that takes it, and the encoding is chosen
 * before the call rather than discovered by retrying a write.
 *
 * So MCP-B's parameter fits ours and not the other way round. Both directions
 * are asserted, and the second stops compiling if MCP-B ever widens too,
 * which is when this note should be deleted.
 */
export const executeToolInputIsWiderHere: Conforms<
  McpBExecuteParams[1],
  OurExecuteParams[1]
> = true;
export const executeToolInputStillNarrowerUpstream: StillDiverges<
  OurExecuteParams[1],
  McpBExecuteParams[1]
> = true;

/** Abort options, which is the position a signal change would move. */
export const executeToolOptionsMatch: Conforms<
  ChromeModelContextExecuteToolOptions,
  NonNullable<OurExecuteParams[2]>
> = true;
export const executeToolSignalIsAnAbortSignal: Equals<
  NonNullable<ChromeModelContextExecuteToolOptions["signal"]>,
  AbortSignal
> = true;

/**
 * Pinned upstream disagreement, not an AgentDesk choice.
 *
 * The current WebMCP specification requires a provider callback of
 * `(input, options)` with `options.signal`, and `webmcp-spec-conformance.ts`
 * holds AgentDesk to it. MCP-B 5.1 declares one parameter, and its polyfill
 * calls `execute(input)` with no options object, so a caller's abort never
 * reaches a handler on that host. `mcp-b-provider.test.ts` records the
 * runtime half of the same fact.
 *
 * Both lines below are falsifiable on purpose. When MCP-B adds the options
 * parameter, they stop compiling, which is the signal to delete them and
 * check whether the polyfill now forwards the signal.
 */
export const mcpBExecuteTakesOneArgument: Equals<
  Parameters<McpBModelContextTool["execute"]>["length"],
  1
> = true;

/**
 * The consequence for `registerTool`. Everything else on MCP-B's
 * `ModelContext` fits AgentDesk's view of it; this member does not, because
 * its tool dictionary omits the options parameter the specification requires.
 * AgentDesk keeps the normative signature and calls the browser through it,
 * which is correct at runtime and simply cannot be expressed as assignability
 * while the two type sets disagree.
 */
export const mcpBRegisterToolStillDiverges: StillDiverges<
  McpBModelContext["registerTool"],
  ModelContextLike["registerTool"]
> = true;
