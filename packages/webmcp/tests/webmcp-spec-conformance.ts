/**
 * Compile-time only; `pnpm typecheck` fails if the adapter drifts from the
 * shared WebMCP declarations. `webmcp-types` is pinned exactly, so a
 * dependency bump is what surfaces a spec change.
 */
import type {
  ModelContextLike,
  NativeToolDefinition,
  RegisteredTool,
  RegisterToolOptions,
} from "../src/webmcp-adapter.ts";

type Conforms<From, To> = [From] extends [To] ? true : never;

/** We hand these to the browser, so they must be legal spec inputs. */
export const toolConforms: Conforms<
  NativeToolDefinition,
  WebMCP.ModelContextTool
> = true;
export const registerOptionsConform: Conforms<
  RegisterToolOptions,
  WebMCP.ModelContextRegisterToolOptions
> = true;

/**
 * The browser hands these back, so every real value must fit our shape. This
 * is what lets `RegisteredTool.title` stay optional and `window` stay absent
 * without the SDK mistyping anything a browser actually returns.
 */
export const registeredToolConforms: Conforms<
  WebMCP.RegisteredTool,
  RegisteredTool
> = true;
export const modelContextConforms: Conforms<
  WebMCP.ModelContext,
  ModelContextLike
> = true;

/**
 * `executeTool` is a Chrome and test-harness extension with no counterpart in
 * the standard surface. Anything else landing here is unreviewed drift.
 */
export const nonstandardSurfaceIsIsolated: Conforms<
  Exclude<keyof ModelContextLike, keyof WebMCP.ModelContext>,
  "executeTool"
> = true;
