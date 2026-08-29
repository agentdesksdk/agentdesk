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

