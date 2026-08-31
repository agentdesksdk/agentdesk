# P2: Repeated live-region announcements are dropped

Status: OPEN

Reviewed commit: `6a1745e`

## Finding

`AgentPresence` writes the announcement string directly into React state. When two completed capabilities emit the same sentence before the 3.2 second clear timer runs, the second `setAnnouncement()` receives the current value. React does not update the live-region DOM, so assistive technology has no new change to announce.

This is common for repeated operations such as adding two notes or processing two similar records.

## Evidence

The component does this for each completed event:

```ts
setAnnouncement(event.announce);
clearTimeout(announceTimer.current);
announceTimer.current = setTimeout(() => setAnnouncement(""), 3200);
```

The second identical value resets the timer but produces no DOM mutation.

## Affected code

- `apps/demo/src/components/AgentPresence.tsx`, announcement state update

## Required behavior

- Make every completed event produce a distinct live-region update, even when its text matches the previous event.
- Preserve polite announcement order when events arrive close together.
- Do not announce a stale message after the component unmounts.

One simple implementation is to clear the live region and schedule the next message on a later animation frame. A small queue is safer if completions can arrive in bursts.

## Regression test

Render `AgentPresence`, emit the same completed announcement twice, and observe live-region DOM mutations. Assert that both events produce an announcement update in order.


## Resolved

Fixed on `0c4694d`, and the finding understated the blast radius.
`ActivityPanel.tsx` held a second `aria-live` region with the same defect and
no clear timer at all, so two identical refusals announced once. That path
gets busier now that an indeterminate rollback is a repeatable outcome.

Both components share one `useAnnouncer` in
`apps/demo/src/components/announcer.ts`. Its queue clears the region before
repeating a string, because an identical value is not a DOM mutation and is
never spoken, and it drains one entry per frame so a burst keeps its order.
Pending frames and timers are cancelled on unmount.

Reproduced and verified in Chrome against the running demo with a
`MutationObserver` on the live region, driving two completions that emit the
same announcement.

```text
before  announcesEmitted 2, liveRegionMutations 1, ["Note added."]
after   announcesEmitted 2, liveRegionMutations 3, ["Note added.", "", "Note added."]
```

Regression test: `apps/demo/tests/announcer.test.ts`.
