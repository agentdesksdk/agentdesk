# The Frappe staging adapter

Status: design only. Nothing here is implemented.

The third staging adapter the roadmap names, written against
`StagingAdapter` in `packages/webmcp/src/staging.ts` as it stands after the
IndexedDB adapter (#53), the awaited commit (#55), the REST adapter (#57),
and the awaited fork (#60). It borrows the shapes the REST adapter settled:
an operation declares the documents it will touch, a version is read off
what the server returns, a commit is refused on a stale version, and a
commit whose answer was lost is indeterminate rather than failed. Where
Frappe's model fits that contract it says so briefly; where it does not,
the gap is named in the same shape as the two existing sections of
`adapter-contract.md`.

Everything asserted about Frappe below is cited to Frappe's documentation
or to the framework source on the `develop` branch, read on 2026-09-03. A
sentence with no citation is this design's, not Frappe's.

## What Frappe gives

**Three document states.** "The docstatus will always have one of the
following three values: 1. Draft (value: 0) 2. Submitted (value: 1) 3.
Cancelled (value: 2)", and "Documents in the submitted and cancelled state
cannot be edited, with one exception: for individual fields we can
explicitly allow edits, even when the document is in the submitted state"
([Docstatus](https://docs.frappe.io/framework/doctypes/docstatus)). In the
source, `DocStatus` is an integer enumeration with `DRAFT` 0, `SUBMITTED`
1, `CANCELLED` 2
([`frappe/model/docstatus.py`](https://github.com/frappe/frappe/blob/develop/frappe/model/docstatus.py)).
The transition a save performs is decided by `check_docstatus_transition`:
from draft, staying draft is `save` and moving to submitted is `submit`;
from submitted, staying submitted is `update_after_submit` and moving to
cancelled is `cancel`
([`frappe/model/document.py`](https://github.com/frappe/frappe/blob/develop/frappe/model/document.py)).
`update_after_submit` is restricted by `validate_update_after_submit` to
fields the DocType marks `allow_on_submit`.

**Submit and cancel are saves with a docstatus.** `Document.submit()`
"Sets `docstatus` = 1, then saves"; `cancel()` "Sets `docstatus` = 2, then
saves" (`document.py`). Over REST they are whitelisted methods, not
resource verbs: `frappe.client.submit(doc)` parses the document it is
given and calls `doc.submit()`; `frappe.client.cancel(doctype, name)` loads
the document and calls `cancel()`; `frappe.client.save(doc)` calls
`doc.save()`
([`frappe/client.py`](https://github.com/frappe/frappe/blob/develop/frappe/client.py)),
each reachable as `POST /api/method/frappe.client.<name>`, since "A request
to an endpoint /api/method/dotted.path.to.method will call a whitelisted
python method" ([REST API](https://docs.frappe.io/framework/user/en/api/rest)).
Resource verbs cover the draft's life: "Create a new document by sending a
`POST` request to `/api/resource/:doctype`", "Update a document by sending
a `PUT` request to `/api/resource/:doctype/:name`", and `DELETE` on the same
path (same page).

**The `modified` stamp is the concurrency token.** `check_if_latest`
"Checks if `modified` timestamp provided by document being updated is same
as the `modified` timestamp in the database", comparing the stored
`modified` with `_original_modified`, which is set from the document as
the caller supplied it, and on mismatch raises `TimestampMismatchError`
with "has been modified after you have opened it … Please refresh to get
the latest document" (`document.py`). So the token a client holds is the
`modified` value it last read, sent back in the body of the save, submit,
or cancel it asks for.

**Amendment.** A document may carry `amended_from`; `validate_amended_from`
requires the document it names to be cancelled, and the amended document's
name is the original's with a numeric suffix, `-1`, then `-2`
([`frappe/model/naming.py`](https://github.com/frappe/frappe/blob/develop/frappe/model/naming.py),
`_set_amended_name`). A submitted document is therefore not edited; it is
cancelled and a new draft is raised in its place.

**The Version doctype is the change history.** When a DocType has
`track_changes`, `save_version` writes a `Version` document on every save
that had a prior state; its data is `changed` as `[fieldname, old, new]`
triples, including `["docstatus", old, new]`, plus `added`, `removed`, and
`row_changed` for child tables
([`frappe/core/doctype/version/version.py`](https://github.com/frappe/frappe/blob/develop/frappe/core/doctype/version/version.py)).
Frappe's Audit Trail reads that history across an amendment chain: "a tool
for viewing the changes made to a submittable doctype across multiple
amended versions", at most five amended versions back
([Audit Trail](https://docs.frappe.io/framework/user/en/audit-trail)).

**A request is a transaction.** "While performing `POST` or `PUT`, if any
writes were made to the database, they are committed at end of the
successful request", "Any **uncaught** exception during handling of request
will rollback the transaction", and "`GET` requests do not cause an implicit
commit" ([Database API](https://docs.frappe.io/framework/user/en/api/database)).
`before_submit` runs before the database write and `on_submit` after it,
inside that same request (`document.py`, `run_before_save_methods` and the
post-save hooks). So a submit that raises anywhere, in validation, in
`before_submit`, or in `on_submit`, leaves nothing behind: the draft is
still docstatus 0 with the fields it had, and every side effect the hooks
attempted is rolled back with it. The one submit that leaves something
behind is the one whose response the client never saw: the request may
have committed, and only a read of the document says which.

## The mapping

### Fork is a draft

A fork is a Frappe draft, of one of two kinds. A **new draft** is a `POST`
to `/api/resource/<DocType>` with docstatus 0; the server names it. An
**amended copy** is a new draft carrying `amended_from` naming a cancelled
document, which Frappe names `<original>-<n>`; its base is the cancelled
original.

As in the REST adapter, the operation declares what it touches. `rows(input)`
there is `docs(input)` here: the documents the operation will read, each
fetched with `GET` before the operation runs, and the fork records for each
its `name`, its `docstatus`, and its `modified` stamp. The draft itself,
once created, is fetched back and its own `modified` recorded, because
Frappe's validate and `fetch_from` fill fields the operation did not set,
and the draft as the server holds it is the thing a person will review.
Fork returns a promise; the runtime awaits it, as it does for REST.

A fork writes exactly one live thing, the draft, and that is the point:
the draft is a real document a person can open in Frappe's own form view
before approving. The human approves the operation, not a description of
it, and here the operation is on the server under its own name.

### Diff is derived from the draft against its base

`diff` compares the draft as the server returned it with the base: for a
new draft, an empty document of that DocType, so every set field is a
change; for an amended copy, the cancelled original. Changes are
field-level `before` and `after`, child rows as added, removed, or changed,
which is the same vocabulary Frappe's `Version` uses. The diff is computed
by the adapter from two documents it fetched; it is not read from the
`Version` doctype, because a `Version` is written by a save and describes
the server's transition after the fact, and the runtime needs the diff
before anyone has approved anything.

`Version` is the audit Frappe already keeps. Once a commit lands, the
`Version` rows the submit wrote, including `["docstatus", 0, 1]`, are the
application's own record of the same change the receipt describes, and a
receipt's evidence link can point at the document's form route, where
Frappe shows that history. The runtime keeps its receipt; it does not
replace Frappe's log and does not ask Frappe to keep the runtime's.

### Commit is submit, behind the stamp

Commit has three steps, in this order.

1. **The stamp check, before submit is called.** The adapter fetches the
   draft and every base document again and compares each `modified` with
   the stamp the fork recorded. Any difference is `StagedCommitRefused`,
   thrown before any write is dispatched. This is the adapter's own
   refusal, and it exists so the runtime's rule holds: a refusal means
   nothing ran. It is not the authoritative check.
2. **Submit, carrying the recorded stamp.** `frappe.client.submit` is
   called with the draft as fetched, whose `modified` is the stamp Frappe
   itself will check in `check_if_latest` inside the request's
   transaction. That is the authoritative check, and it closes the gap the
   first step leaves open between the read and the write. A
   `TimestampMismatchError` in the response is a refusal with nothing
   written, on the framework's word: the request raised, so the request
   rolled back. Any other exception in the response, a validation error,
   a `before_submit` or `on_submit` hook that raised, is the same kind of
   refusal for the same reason, and the draft is left as it was.
3. **A response that never arrived is indeterminate.** A network failure
   after the request was sent proves nothing about whether it committed.
   The adapter raises for `StagedCommitIndeterminate`, the runtime records
   an unknown outcome, and `identify` below names the draft so a person
   can settle it with one read.

Because one commit is one document in one request, "nothing written" here
is the framework's promise, not the integrator's, which is the opposite of
the REST adapter's batch endpoint, where atomicity is declared on the
integrator's word. Inside a plan the promise is per request, so a plan of
several documents is partial between operations the way a REST commit
without a batch is between rows.

### Release deletes the draft

`release` is `DELETE /api/resource/<DocType>/<name>` on the draft. For an
amended copy it deletes the amended draft and leaves the cancelled original
cancelled, because the cancel was its own committed operation, never the
fork's doing.

### Identify and resolveArtifact are the draft's name

`identify` returns the DocType, the draft's name, its kind, the name it
amends when it amends one, and the recorded stamps. `resolveArtifact`
fetches by name, and the document's docstatus is the verdict a person
needs: 1, the commit landed; 0, it did not and the draft is intact; 2, it
landed and someone has since cancelled it; not found, the draft was deleted,
which only a release or a person could have done. Absence is an answer
here as it is for the IndexedDB adapter's committed fork.

### What an amended-cancel cycle means for a plan

To change a submitted document a person cancels it and raises an amended
copy, and Frappe will not accept the copy until the original is cancelled
on the server. As a plan that is two operations. The first, `cancel`, has
no draft: its fork records the submitted document and its stamp, its diff
is `["docstatus", 1, 2]` and nothing else, and its commit is
`frappe.client.cancel` behind the same stamp check. The second, `amend`,
forks the amended draft against the cancelled original and commits with
submit.

The plan's preview cannot show the second operation as a server draft,
because the draft cannot exist until the first commit has landed. The
preview for `amend` is therefore derived locally, the original's fields
with the operation's edits applied, and the fork that creates the real
draft happens at commit time, after `cancel` has answered. Its base stamp
is the original's `modified` as the cancel acknowledged it, which is what
the REST adapter records as `follows`. The amended name, `<original>-<n>`,
is not known at preview either; the receipt carries it once the draft
exists.

## What the contract as written cannot express

Same shape as the two existing sections: each item is something this
adapter needs and the contract does not say.

1. **A fork that cannot exist until its predecessor commits.** `scope`
   says forks chain and a later fork derives against the earlier one's
   staged head. Frappe refuses an amended draft whose original is not yet
   cancelled, so the second fork of a cancel-and-amend plan can only be a
   local derivation at preview time and a server draft at commit time.
   The contract has one `fork`, called before `diff`, and no notion of a
   fork that is re-done for real at commit.

2. **The version is the document's, not the row's.** The IndexedDB section
   left open what a row's version is and answered it with a version per
   row. Frappe's answer is one `modified` stamp per parent document, and
   child rows ride under it. The contract's `stateDigest` covers each
   change's field and `before` value, and the fork's base is what the
   adapter chooses to record; nothing in the contract lets an adapter say
   that its version is coarser than its changes, and nothing lets the
   runtime's refusal message say which of the two, digest or stamp,
   refused.

3. **A commit does more than the diff shows.** `diff` is "what this staged
   run did", read off the draft. A submit runs `on_submit`, and in an
   ERPNext deployment that posts ledger entries, moves stock, and creates
   linked documents, none of which is in the draft. The person approves a
   diff of one document and the commit changes several. The contract has
   no field for "what the commit will also do", and a `Version` on another
   DocType is the only trace afterwards.

4. **The backend can say whether an unknown outcome landed, and the
   contract has no channel for the answer.** `resolveArtifact` hands back
   the artifact; a human reads it and decides. Here one `GET` reads the
   docstatus and the verdict is the server's, not a person's judgement,
   and the adapter can only surface it as prose in the artifact. The REST
   section's item 3 is the same silence about partial application; this
   is the same silence about a definite answer.

5. **Two refusals, one word.** The adapter's stamp check refuses before
   dispatch on its own authority; Frappe's `check_if_latest` refuses inside
   the transaction on the framework's. Both are `StagedCommitRefused`. The
   REST section's item 5 asked how an adapter says on whose authority
   nothing was written; here the two authorities are different and the
   stronger one is the second, and the contract still has one class and a
   message.

6. **Release is a live write that can fail and leave a visible leftover.**
   The contract says `release` disposes of a run that will never land and
   treats a rejection as a failed cleanup. Here a failed `DELETE`, refused
   by permissions or by a link, leaves a draft in Frappe's list views that
   users will find, and the contract has no place to record where the
   leftover lives or who should remove it.

7. **The server names the artifact.** `identify` is called after fork, so
   it works, but the amended name is assigned at insert and the draft's
   name under a naming series is too. A plan's preview cannot name the
   document a later operation will create, and the record of an unknown
   outcome for an operation whose fork never ran has no name to resolve
   by. The IndexedDB section's item 3 is the neighbouring gap.

## Where Frappe makes a guarantee stronger or weaker

**The digest.** The runtime binds an approval to `stateDigest` over the
diff's fields and `before` values. Frappe adds a second binding, the
`modified` stamp of each document the fork read, and the stamp is a
coarser version than a row digest, in both directions. Coarser means
stricter where it applies: any save of the document between preview and
commit moves the stamp and refuses the commit, even a save that touched a
field the person never saw, so a decision reviewed against an old
document is refused more often than the digest alone would refuse it.
Coarser means weaker where it does not apply: a value can change under the
stamp without moving it, through a database write that does not go
through the document. Frappe's own `frappe.db.set_value` "won't call ORM
triggers like `validate` and `on_update`" and takes an `update_modified`
argument to "update without updating the `modified` timestamp"
([Database API](https://docs.frappe.io/framework/user/en/api/database)),
and raw SQL sees no stamp at all. After such a write the digest is the
only check that sees the `before` value move. Both bindings hold on every commit, and the refusal
names which one failed. Neither sees a change to a document the operation
did not declare in `docs(input)`.

**Atomicity is stronger than REST and narrower than IndexedDB.** One
document, one request, one transaction, rolled back on any exception on
the framework's word, so a refused submit is a clean refusal without an
integrator's promise. It is per request, so a plan is partial between
operations, and a lost response is the one indeterminate case, exactly
one document wide.

**The human approves a real object.** The draft exists on the server under
Frappe's permissions before approval, and a reviewer can open it in the
form view Frappe already has. The runtime's "the human approves the
operation, not a description of it" is stronger here than with an
in-memory fork, because the object is not the runtime's copy.

**The diff is weaker than the commit.** A submit's hooks change documents
the diff never mentions (item 3 above). The receipt is honest about the
document; it cannot be complete about the deployment.

**Audit is doubled, not shared.** Frappe's `Version` records the same
transition the receipt records, from the server's side, and survives the
runtime's process. The runtime's receipt records who approved, against
which digest and stamp, which `Version` never will. An evidence link from
the receipt to the document's form route lets a person see both.

**Cancel is consequential and its diff is one field.** `["docstatus", 1,
2]` is the whole diff of a cancel, and in ERPNext a cancel reverses
ledger entries. The approval evidence for a cancel is therefore thin by
construction, and a capability that cancels should declare
`approvalEvidence: "summary"` and say what the summary omits.

## Open questions

- Whether the stamp check in step 1 of commit is worth its round trip,
  given Frappe's own check is authoritative and closes the race the first
  cannot. The argument for keeping it is the runtime's refusal-before-
  dispatch rule; the argument against is that it is a second read that
  can itself be stale.
- Whether `docs(input)` should include the documents a submit's hooks will
  write, so their stamps are checked too. That would make item 3 above
  partly visible at the cost of asking the operation author to know
  ERPNext's posting logic.
- How much of the local preview of an amended draft can be trusted before
  Frappe's validate has run on the real draft.

<!-- code-anchors
packages/webmcp/src/staging.ts StagingAdapter StagedCommitIndeterminate StagedCommitRefused stateDigest identify scope
packages/webmcp/src/rest-staging.ts restStaging RestCommitPartial rows follows acknowledged
packages/webmcp/src/indexeddb-staging.ts indexedDbStaging resolveArtifact
-->
