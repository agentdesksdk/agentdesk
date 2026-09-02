import { useState } from "react";
import { useAnnouncer } from "./announcer.ts";
import { useRuntime } from "./hooks.ts";

const EXPIRY_OPTIONS = [
  ["15", "15 minutes"],
  ["60", "1 hour"],
  ["240", "4 hours"],
] as const;

export function GrantCard({ orderId }: { orderId: string }) {
  useRuntime();
  const { announcement } = useAnnouncer();
  const [usesInput, setUsesInput] = useState("1");
  const [minutes, setMinutes] = useState("60");

  return (
    <div
      className="panel grant-card"
      role="region"
      aria-label={`Agent authority on order #${orderId}`}
      tabIndex={-1}
    >
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <h2>Agent authority</h2>
      <p className="grant-none">No live grant. Every refund on this order asks a person.</p>
      <form className="grant-form" onSubmit={(event) => event.preventDefault()}>
        <label>
          Uses
          <input
            type="number"
            name="uses"
            min={1}
            step={1}
            value={usesInput}
            onChange={(event) => setUsesInput(event.target.value)}
          />
        </label>
        <label>
          Expires in
          <select
            name="expires"
            value={minutes}
            onChange={(event) => setMinutes(event.target.value)}
          >
            {EXPIRY_OPTIONS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="primary">
          Grant refund shipping
        </button>
      </form>
    </div>
  );
}
