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
- **Active WebMCP tool count** — tools currently registered (bootstrap
  included).
- **Serialized schema bytes** — UTF-8 length of the serialized definitions
  (name, title, description, inputSchema, annotations) of every currently
  registered tool, summed. This is exactly what the page handed to
  `registerTool`.
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

## Running a comparison

1. Open `/baseline/benchmark`, click **Start run in current mode**.
2. Complete the hero task with your agent, click **Stop & save run**.
3. Click **Reset Demo**, switch to `/agentdesk/benchmark`, repeat.
4. Compare the two rows. Runs persist in `localStorage`; **Clear saved
   runs** resets the table.

Typical shape of the result (actual numbers vary with the catalog): baseline
registers ~82 tools and tens of kilobytes of schema up front; AgentDesk
starts at 4 tools / ~2 KB and peaks at 10 tools during the task.
