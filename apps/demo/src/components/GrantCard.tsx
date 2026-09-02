import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Grant } from "@agentdesk/webmcp";
import { agentdesk, OPERATOR } from "../runtime/agentdesk.ts";
import { useAnnouncer } from "./announcer.ts";
import {
  REFUND_SHIPPING,
  fmtTime,
  grantIssuedAnnouncement,
  grantRevokedAnnouncement,
  grantSentence,
  grantStateText,
  grantUsesText,
  isGrantOnOrder,
} from "./grant-text.ts";
import { useRuntime } from "./hooks.ts";

const EXPIRY_OPTIONS = [
  ["15", "15 minutes"],
  ["60", "1 hour"],
  ["240", "4 hours"],
] as const;

function endedAt(grant: Grant): string {
  switch (grant.state) {
    case "live":
      return `expires ${fmtTime(grant.expiresAt)}`;
    case "exhausted":
      return `exhausted ${fmtTime(grant.exhaustedAt)}`;
    case "expired":
      return `expired ${fmtTime(grant.expiredAt)}`;
    case "revoked":
      return `revoked ${fmtTime(grant.revokedAt)}`;
  }
}

/**
 * A bounded mandate for refund_shipping on one order, issued and revoked by
 * the person at the keyboard. The runtime holds the grant; this card only
 * shows what the snapshot says and signs the two calls with the operator,
 * the same identity that approves.
 *
 * The scope is the order id, the field refund_shipping takes. Every state
 * and every limit is text; nothing here means anything by colour alone.
 */
export function GrantCard({ orderId }: { orderId: string }) {
  const snapshot = useRuntime();
  const { announcement, announce } = useAnnouncer();
  const [usesInput, setUsesInput] = useState("1");
  const [minutes, setMinutes] = useState("60");
  const [refusal, setRefusal] = useState<string | null>(null);
  const region = useRef<HTMLDivElement>(null);
  const [pendingFocus, setPendingFocus] = useState(false);

  // Revoke replaces the button that held focus with text, so focus is placed
  // on the card before the browser drops it to document.body.
  useEffect(() => {
    if (!pendingFocus) {
      return;
    }
    region.current?.focus();
    setPendingFocus(false);
  }, [pendingFocus]);

  const onOrder = snapshot.grants
    .filter((grant) => grant.capability === REFUND_SHIPPING && isGrantOnOrder(grant, orderId))
    .reverse();
  const live = onOrder.some((grant) => grant.state === "live");

  function issue(event: FormEvent) {
    event.preventDefault();
    const outcome = agentdesk.grant(
      {
        capability: REFUND_SHIPPING,
        scope: { order_id: orderId },
        uses: Number(usesInput),
        expiresAt: Date.now() + Number(minutes) * 60_000,
      },
      OPERATOR,
    );
    if (outcome.ok) {
      setRefusal(null);
      announce(grantIssuedAnnouncement(outcome.grant));
    } else {
      setRefusal(outcome.reason);
      announce(`Not granted. ${outcome.reason}`);
    }
  }

  function revoke(grant: Grant) {
    const outcome = agentdesk.revokeGrant(grant.id, OPERATOR);
    announce(
      outcome.ok
        ? grantRevokedAnnouncement(outcome.grant)
        : `Could not revoke grant ${grant.id}. ${outcome.reason}`,
    );
    setPendingFocus(true);
  }

  return (
    <div
      ref={region}
      className="panel grant-card"
      role="region"
      aria-label={`Agent authority on order #${orderId}`}
      tabIndex={-1}
    >
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <h2>Agent authority</h2>
      {live ? null : (
        <>
          <p className="grant-none">
            No live grant. Every shipping refund on this order asks a person.
          </p>
          <form className="grant-form" onSubmit={issue}>
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
          {refusal !== null ? (
            <p className="grant-refusal" role="alert">
              Not granted: {refusal}
            </p>
          ) : null}
        </>
      )}
      {onOrder.map((grant) => {
        const authorized = agentdesk.queryReceipts({ grantId: grant.id }).length;
        return (
          <div
            key={grant.id}
            className={`grant ${grant.state}`}
            data-grant={grant.id}
            data-state={grant.state}
          >
            <p className="grant-sentence">{grantSentence(grant)}</p>
            <div className="stat-row">
              <span>Grant</span>
              <span className="num">{grant.id}</span>
            </div>
            <div className="stat-row">
              <span>State</span>
              <span className="num">{grantStateText(grant)}</span>
            </div>
            <div className="stat-row">
              <span>May call</span>
              <span className="num">{grant.capability}</span>
            </div>
            <div className="stat-row">
              <span>Scope</span>
              <span className="num">order_id = {orderId}</span>
            </div>
            <div className="stat-row">
              <span>Uses</span>
              <span className="num">{grantUsesText(grant)}</span>
            </div>
            <div className="stat-row">
              <span>Time</span>
              <span className="num">{endedAt(grant)}</span>
            </div>
            <div className="stat-row">
              <span>Issued by</span>
              <span className="num">{grant.issuedBy.name ?? grant.issuedBy.id}</span>
            </div>
            <div className="stat-row">
              <span>Refunds it authorized</span>
              <span className="num">{authorized}</span>
            </div>
            {grant.state === "live" ? (
              <div className="actions">
                <button
                  type="button"
                  className="danger"
                  aria-label={`Revoke grant ${grant.id}`}
                  onClick={() => revoke(grant)}
                >
                  Revoke
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
