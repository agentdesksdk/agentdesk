import { describe, expect, it } from "vitest";
import { capabilities, capabilityDomains } from "../src/capabilities/index.ts";

describe("capability catalog", () => {
  it("has a realistic size (70-100) with unique names", () => {
    expect(capabilities.length).toBeGreaterThanOrEqual(70);
    expect(capabilities.length).toBeLessThanOrEqual(100);
    const names = capabilities.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("covers all seven product domains", () => {
    const domains = new Set(capabilities.map((c) => c.domain));
    for (const domain of capabilityDomains) {
      expect(domains).toContain(domain);
    }
  });

  it("declares descriptions, schemas, and risk on every capability", () => {
    for (const capability of capabilities) {
      expect(capability.description.length).toBeGreaterThan(10);
      expect(capability.inputSchema.type).toBe("object");
      expect(["READ", "WRITE", "CONSEQUENTIAL"]).toContain(capability.risk);
    }
  });

  it("requires approval exactly for consequential capabilities", () => {
    for (const capability of capabilities) {
      expect(capability.policy.kind === "approval_required").toBe(
        capability.risk === "CONSEQUENTIAL",
      );
    }
    const consequential = capabilities.filter((c) => c.risk === "CONSEQUENTIAL");
    expect(consequential.map((c) => c.name)).toContain("refund_shipping");
    expect(consequential.map((c) => c.name)).toContain("cancel_order");
  });

  it("read capabilities carry the readOnly hint", () => {
    for (const capability of capabilities) {
      if (capability.risk === "READ") {
        expect(capability.annotations.readOnlyHint).toBe(true);
      }
    }
  });
});
