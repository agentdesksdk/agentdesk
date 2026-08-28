# Baseline vs AgentDesk benchmark

The demo ships a control condition so the capability-virtualization claim is
measurable instead of asserted.

## The two arms

| | `/baseline` | `/agentdesk` |
| --- | --- | --- |
| Exposure | Entire applicable catalog registered flat | Bootstrap 4 + routed working set (≤6) |
| Catalog | identical (78 capabilities) | identical |
| Handlers | identical | identical |
| Pipeline | identical | identical |

The only difference is the exposure strategy (`exposure: "flat"` vs
`"routed"` on the same runtime).

## What is measured

Everything comes from the live runtime, nothing is hardcoded:

- **Catalog capability count** — size of the app catalog.
- **Active WebMCP tool count** — tools currently registered, reported as
  application + runtime so the arithmetic is checkable
  (e.g. baseline 78 application + 4 runtime = 82 total).
- **Serialized schema bytes** — UTF-8 length of the serialized definitions
  (name, title, description, inputSchema, annotations) of every currently
  registered tool, summed. This is exactly what the page handed to
  `registerTool`. A timed run records three figures:
  **bytes before routing**, **peak bytes during the task**, and **bytes at
  stop**.
- **Tool invocations** — count of `capability_invoked` audit events during a
  timed run.
- **Stale calls** — invocations that hit a tombstoned (retired) tool.
- **Approvals** — `approval_requested` events.
- **Task completion** — a run auto-marks complete when `refund_shipping`
  executes (the hero task's terminal action).
- **Elapsed time** — wall clock between Start and Stop.

## What is estimated, and how

**Estimated schema tokens** = schema bytes ÷ 4, rounded. The same estimator
is applied to both modes and every figure is labelled "estimated" in the UI.

## What is deliberately not claimed

- Model token consumption. That depends on the client and is not observable
  from the page.
- Model choice quality. We report tool-surface size and call counts; we do
  not simulate agent reasoning.

## The fair comparison point

Compare both modes **at task time (peak)**, not against AgentDesk's idle
surface. AgentDesk idles at 4 bootstrap tools, but the honest comparison is
the moment both modes are actually doing the hero task:

```text
                       BASELINE      AGENTDESK
Application catalog        78            78
Runtime tools               4             4
Routed application tools   78             5
Total active tools         82             9
Schema bytes           (peak)         (peak)   ← both measured live
```

The `78 → 5` routing reduction stands on its own; the byte comparison must
use peak-vs-peak. The run table reports before/peak/stop for every run so
the idle figure can never be mistaken for the task figure.

Sample measurement (2026-08-28, local build, hero task routed via
`find_capabilities`; reproduce with the run table or the console):

```text
                       BASELINE      AGENTDESK
Total active tools         82             9
Bytes before routing    27,286         1,836
Bytes peak (task)       27,286         3,728
Est. tokens (peak)      ~6,822          ~932   (bytes ÷ 4, estimated)
```

## Running a comparison

1. Open `/baseline/benchmark`, click **Start run in current mode**.
2. Complete the hero task with your agent, click **Stop & save run**.
3. Click **Reset Demo**, switch to `/agentdesk/benchmark`, repeat.
4. Compare the two rows at **Bytes peak (task)**. Runs persist in
   `localStorage`; **Clear saved runs** resets the table.
