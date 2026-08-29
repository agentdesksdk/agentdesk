# Accessibility

An agent that reports success is not enough. If the person it acted for
cannot independently find what changed, check it, and undo it, the agent has
asked to be trusted rather than earned it.

AgentDesk treats the proof of an action as something a human navigates, not
something a sighted human glances at. That means keyboard reachability,
deterministic focus, and announcements that name the thing that changed.

## The focus contract

Moving someone's keyboard focus is an intrusion. It is correct exactly once,
when the human authorized an action and the control they pressed is about to
disappear. It is wrong every other time.

The runtime encodes this rather than leaving it to the UI's judgement. A
capability opts in by declaring a focus policy in its presentation block.

```ts
presentation: {
  route: orderRoute,
  reveal: "shipping-summary",
  focus: "on_explicit_request",
  announce: (input) => {
    const order = orderFromInput(input);
    return order
      ? `Shipping refund of ${money(order.shippingFee)} applied to order ${order.id}.`
      : "Shipping refund applied.";
  },
}
```

Focus moves only when all of these hold.

The phase is `capability_completed`. Nothing takes focus while work is still
in flight.

The policy is `on_explicit_request`. Absent means never, so focus stealing is
opt-in per capability.

`humanInitiated` is true. The runtime sets this only on the path through
`approve()`. An agent calling a tool in the background cannot satisfy it, and
neither can a plan commit. This is the load-bearing condition, and it is
enforced in the runtime rather than described in a comment.

The `executionId` has not already spent its handoff. Focus moves at most once
per execution.

The reveal target is a registered token. Which brings us to the part that
matters most.

## There is no focus tool, deliberately

A tool that accepts a target and moves focus hands an agent the ability to
move a person's focus anywhere on the page. AgentDesk does not ship one and
should not.

Reveal targets are opaque ids the application author put on its own elements,
matched as `[data-reveal="..."]`. The token is validated against
`/^[a-z0-9][a-z0-9-]*$/i` before it reaches `querySelector`, so no quote,
bracket, backslash, or whitespace can survive into a selector. An agent
supplies the capability input; it never supplies the target.

The practical consequence is that AgentDesk can only move focus to somewhere
the application already decided was a meaningful landing place.

## Receipts are navigable objects

A receipt records what changed. To be reviewable it also has to say what it
changed it to, in a form a person can travel to.

```ts
receipt({
  entity: `Order #${order.id}`,
  changes,
  affected: [
    {
      kind: "order",
      id: order.id,
      label: `Order #${order.id}`,
      reveal: "shipping-summary",
    },
  ],
  result: { order_id: order.id, shipping_refunded: true },
})
```

Each affected object renders as a real button in the activity rail, so it is
reachable by Tab and announced as a control. Every control carries an
accessible name that identifies which receipt it acts on, because "Undo"
alone tells a screen reader user nothing about what they are undoing.

Review state lives beside the receipt, never inside it. Marking something
reviewed does not change what occurred, so `reviewedAt` and `reviewedBy` sit
on the stored entry while the receipt envelope stays immutable.

## Three-minute keyboard test

This is the judge path. It uses Tab, Shift+Tab, Enter, and Space only. Put
the mouse away.

### Setup

Chrome 152 or newer with WebMCP enabled, plus a connected WebMCP client. On
Windows run NVDA. On macOS run VoiceOver with Cmd+F5. The demo works without
a screen reader, but sections 2 and 4 are only fully observable with one.

Open the demo, press "Reset Demo", then navigate to order 10428.

### 1. Keyboard access, 30 seconds

Press Tab once from the top of the page. The first stop is "Skip to main
content" and it becomes visible when focused. Press Enter and focus lands on
the main region.

Continue tabbing. Confirm you can reach the mode switch, the presence toggle,
the section navigation, and the activity rail without a mouse.

Confirm the screen reader announces two named regions, "Sections" and
"AgentDesk activity and receipts", so the rail is reachable by landmark
rather than only by exhaustive tabbing.

### 2. Agent refund request, 60 seconds

Give the agent this prompt.

> Refund the shipping fee on order 10428.

Expected. The agent calls `refund_shipping` and receives `APPROVAL_REQUIRED`
rather than a result. Nothing has changed yet. An approval card appears in
the rail naming the amount, the customer, and the field-level diff.

The agent must not block waiting. This is the two-phase approval contract and
it is what keeps a consequential write from happening on the agent's say-so.

### 3. Approval and focus handoff, 30 seconds

Tab to the Approve button and press Enter.

Expected, in order. The write executes. The screen reader announces the
completion sentence naming the order. Keyboard focus moves once to the
shipping summary panel, which is the object that changed, and the panel is
announced by its region label.

Focus moves here because the button you just pressed is gone. Without the
handoff your focus would fall to the document body and you would have to
start tabbing from the top to find out what happened.

Now repeat the same refund through the agent's plan path rather than the
approval button. Focus must not move. That is the difference between a human
authorizing an action and an agent performing one.

### 4. Review and undo without a mouse, 60 seconds

Tab into the activity rail and find the receipt. It is a region labelled
"Receipt for Order #10428", so you can move to it by landmark.

Tab through its controls and confirm each announces what it acts on rather
than a bare verb. You should hear the affected-object button, "Mark
reviewed", and "Undo", each naming the refund and the order.

Activate the affected-object button. The application navigates to the order
and reveals the shipping summary.

Activate "Mark reviewed". The control is replaced by reviewed state, focus
lands on the receipt region rather than falling to the body, and the live
region reads "Marked reviewed. Refund shipping on Order #10428."

Activate "Undo". The refund is reversed, the order reads unrefunded again,
focus lands on the receipt region, and the live region reads "Rolled back
refund shipping on Order #10428."

Both controls unmount when activated. Landing focus on the enclosing receipt
region is what stops it falling to the document body and forcing you to tab
from the top of the page to find out what happened.

### 5. Zoom, 15 seconds

Set browser zoom to 200%. The activity rail moves below the main content
instead of disappearing, so receipts, review, and undo stay reachable. Repeat
one control from section 4 to confirm.

### Pass criteria

The agent discovered and invoked the capability through WebMCP. The
consequential write waited for a human. The receipt recorded field-level
before and after values and was verified by reading state back. Every step of
discovery, review, and undo was reachable with the keyboard alone. Focus
moved exactly once, to the object that changed, and never fell to the
document body. The screen reader announced each outcome by name.

## What this document does not claim

I verified the following in Chrome against the built application, not against
a mock. The skip link moves from -48px to 0 on focus. The two complementary
landmarks are named. Every `data-reveal` anchor exposes `role="region"` and a
label naming its entity. Approving the refund moves focus exactly once onto
the shipping summary region. Marking reviewed and undoing each land focus on
the receipt region rather than the document body, and each writes its own
sentence into the live region. At 902px the rail is reachable and its
controls are focusable.

I have not run NVDA or VoiceOver against this build. Screen reader behavior
differs between readers and between browsers, and the wording quoted above is
what the live region contains rather than what a specific reader speaks.
Treat the screen reader steps as unverified until someone runs them. That is
the single largest gap in this document.

The reveal-token guard is unit tested. The DOM behavior around it is verified
by hand in a browser rather than by an automated test, because the demo has
no jsdom environment and adding one to assert focus movement was not worth
the dependency.

Colour is never the only carrier of meaning in the receipt. Verification
status is text. The colour is redundant with it.
