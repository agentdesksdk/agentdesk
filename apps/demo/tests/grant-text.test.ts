import { describe, expect, it } from "vitest";
import type { Grant, HumanActor, StoredReceipt } from "@agentdesk/webmcp";
import {
  authorityLine,
  consideredGrantText,
  grantOrderId,
  grantStateText,
  outcomeWords,
  receiptAuthorityText,
} from "../src/components/grant-text.ts";

const OPERATOR: HumanActor = { id: "operator", name: "Operator", kind: "human" };

/** A grant record as the runtime hands it out; the brands are cast, not minted. */
function grant(over: Partial<Grant> & { state?: Grant["state"] } = {}): Grant {
  const base = {
    id: "GRT-1",
    capability: "refund_shipping",
    scope: [{ field: "order_id", kind: "exact", value: "10428" }],
    uses: 3,
    remaining: 3,
    issuedBy: OPERATOR,
    issuedAt: 1000,
    expiresAt: 100_000,
    state: "live",
  };
  return { ...base, ...over } as unknown as Grant;
}

describe("grant words", () => {
  it("reads the order off an exact order_id rule and nothing else", () => {
    expect(grantOrderId(grant())).toBe("10428");
    expect(grantOrderId(grant({ scope: [] } as Partial<Grant>))).toBeUndefined();
    expect(
      grantOrderId(
        grant({
          scope: [{ field: "amount", kind: "bound", max: 25 }],
        } as unknown as Partial<Grant>),
      ),
    ).toBeUndefined();
  });

  it("the authority line is read + propose without a live grant, and names each live grant with one", () => {
    expect(authorityLine([])).toBe("read + propose");
    expect(authorityLine([grant({ state: "revoked", revokedAt: 5, revokedBy: OPERATOR } as Partial<Grant>)])).toBe(
      "read + propose",
    );
    expect(authorityLine([grant({ remaining: 2 })])).toBe("refund shipping ≤ 2 uses on order 10428");
    expect(authorityLine([grant({ remaining: 1 })])).toBe("refund shipping ≤ 1 use on order 10428");
    expect(
      authorityLine([
        grant({ remaining: 1 }),
        grant({ id: "GRT-2", remaining: 4, scope: [] } as unknown as Partial<Grant>),
      ]),
    ).toBe("refund shipping ≤ 1 use on order 10428; refund shipping ≤ 4 uses");
  });

  it("every grant state is words, never a colour", () => {
    expect(grantStateText(grant({ remaining: 2 }))).toBe("live, 2 of 3 uses left");
    expect(grantStateText(grant({ state: "exhausted", remaining: 0, exhaustedAt: 9 } as Partial<Grant>))).toBe(
      "exhausted, all 3 uses spent",
    );
    expect(grantStateText(grant({ state: "expired", remaining: 1, expiredAt: 9 } as Partial<Grant>))).toBe(
      "expired, 1 use unused",
    );
    expect(
      grantStateText(
        grant({ state: "revoked", remaining: 2, revokedAt: 9, revokedBy: OPERATOR } as Partial<Grant>),
      ),
    ).toBe("revoked by Operator, 2 uses unused");
  });

  it("says what a considered grant stopped at, reading a bound off the grant when the audit lacks it", () => {
    expect(outcomeWords({ id: "GRT-1", outcome: "exhausted" }, grant({ state: "exhausted" } as Partial<Grant>))).toBe(
      "is exhausted, all 3 uses spent",
    );
    expect(outcomeWords({ id: "GRT-1", outcome: "expired" })).toBe("expired before this call");
    expect(
      outcomeWords(
        { id: "GRT-1", outcome: "revoked" },
        grant({ state: "revoked", revokedBy: OPERATOR } as Partial<Grant>),
      ),
    ).toBe("was revoked by Operator");
    expect(outcomeWords({ id: "GRT-1", outcome: "missing_field", field: "order_id" })).toBe(
      "needs order id on the call, and this call did not carry it",
    );
    expect(outcomeWords({ id: "GRT-1", outcome: "out_of_scope", field: "order_id" }, grant())).toBe(
      "covers order 10428, not this order id",
    );
    const bounded = grant({
      scope: [{ field: "amount", kind: "bound", min: 5, max: 25 }],
    } as unknown as Partial<Grant>);
    expect(outcomeWords({ id: "GRT-1", outcome: "over_bound", field: "amount", max: 25 })).toBe(
      "allows amount up to 25, and this call asked for more",
    );
    expect(outcomeWords({ id: "GRT-1", outcome: "over_bound", field: "amount" }, bounded)).toBe(
      "allows amount up to 25, and this call asked for more",
    );
    expect(outcomeWords({ id: "GRT-1", outcome: "under_bound", field: "amount" }, bounded)).toBe(
      "allows amount down to 5, and this call asked for less",
    );
    expect(consideredGrantText({ id: "GRT-1", outcome: "exhausted" }, grant({ state: "exhausted" } as Partial<Grant>))).toBe(
      "Grant GRT-1 was considered and did not apply: it is exhausted, all 3 uses spent. A person decides.",
    );
  });

  it("a receipt names the grant that authorized it, and says nothing when a person approved", () => {
    const entry = { grantId: "GRT-1" } as StoredReceipt;
    expect(receiptAuthorityText(entry)).toBe("Authorized by grant GRT-1, with no approval asked");
    expect(receiptAuthorityText({} as StoredReceipt)).toBeUndefined();
  });
});
