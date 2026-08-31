# P2: the extension message boundary forbids the request channel it needs

Status: **RESOLVED**

Reviewed worktree: `noble-orbit`, commit `a0c5f23` (PR #13)

## Finding

The trust-boundary section correctly says origin is routing rather than
authentication and that privileged decisions belong in the extension. It
then says a privileged action "must never be reachable by a message the page
can synthesize." Read literally, that forbids a page from requesting any
extension-mediated operation, which is the channel the planned dynamic
WebMCP extension needs.

The security property is not that an untrusted page cannot reach a request
handler. It is that a page message cannot supply or substitute the extension's
authorization, human identity, grant, policy decision, or confirmation. The
extension may accept an untrusted request, validate it, render its own approval
surface, and execute privileged work only after its own gate succeeds.

Affected code: `docs/mcp-b-interop.md:100-107`.

## Required correction

Replace "must never be reachable" with language that separates requesting
from authorizing and executing. Make clear that all page messages are
untrusted input, privileged handlers remain extension-owned, and page-provided
claims of approval are ignored. Preserve the existing point that origin pins
route messages but do not authenticate their intent.

## Regression requirement

Documentation only. Include one allowed sequence (page requests, extension
validates and obtains its own confirmation, extension executes) and one
forbidden sequence (page sends a message claiming approval, extension executes
without an independent gate).

## Resolution

The section separates requesting from authorizing. A page message may request
privileged work, which is the point of the channel, and is treated as ordinary
untrusted input: parsed, validated, rate-limited. It may never supply the
authorization. Validation, human identity, the approval surface, the policy
decision, the credential, and the execution stay in the extension's own
context, and a page-supplied claim that a human already approved is ignored.

Both sequences the finding asked for are written out: an allowed one where the
page requests, the extension validates and obtains its own confirmation, and
then executes; and a forbidden one where the page asserts approval and the
extension acts on it. The closing line names the distinction directly. The
question is not whether the handler is reachable, it is whether reaching it is
sufficient.

The earlier point that origin pins route messages without authenticating their
intent is unchanged.
