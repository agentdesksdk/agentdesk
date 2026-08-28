import {
  CapabilityUnavailableError,
  unavailable,
  type Capability,
} from "@agentdesk/webmcp";
import { getState, mutate } from "../data/store.ts";
import {
  createReadCapability,
  createStateTransitionCapability,
  createUpdateCapability,
} from "./factories.ts";
import {
  money,
  num,
  obj,
  requireCustomer,
  requireOrder,
  requireStr,
  s,
  n,
} from "./helpers.ts";

const domain = "billing";

function requireInvoice(input: Record<string, unknown>) {
  const id = requireStr(input, "invoice_id");
  const invoice = getState().invoices.find(
    (inv) => inv.id.toLowerCase() === id.toLowerCase(),
  );
  if (!invoice) {
    throw new CapabilityUnavailableError(
      unavailable("MISSING_INVOICE", `No invoice ${id} exists.`, "list_invoices"),
    );
  }
  return invoice;
}

export const billingCapabilities: Capability[] = [
  createReadCapability({
    name: "get_invoice",
    title: "Get invoice",
    description: "One invoice with total, status, and linked order.",
    domain,
    intents: ["invoice details"],
    keywords: ["invoice", "bill"],
    routes: ["/billing"],
    inputSchema: obj({ invoice_id: s("Invoice id like INV-3001") }, ["invoice_id"]),
    execute: (input) => requireInvoice(input),
  }),
  createReadCapability({
    name: "list_invoices",
    title: "List invoices",
    description: "All invoices, optionally filtered by status.",
    domain,
    keywords: ["invoice", "list", "due", "paid"],
    routes: ["/billing"],
    inputSchema: obj({ status: s("Optional: paid, due, void, partially_refunded") }),
    execute: (input) => {
      const status = input.status;
      const invoices = getState().invoices.filter((inv) =>
        typeof status === "string" && status !== "" ? inv.status === status : true,
      );
      return { count: invoices.length, invoices };
    },
  }),
  createReadCapability({
    name: "list_customer_invoices",
    title: "List customer invoices",
    description: "Invoices belonging to one customer.",
    domain,
    keywords: ["invoice", "customer"],
    entities: ["customerId"],
    inputSchema: obj({ customer_id: s("Customer id") }, ["customer_id"]),
    execute: (input) => {
      const customer = requireCustomer(input);
      const invoices = getState().invoices.filter(
        (inv) => inv.customerId === customer.id,
      );
      return { customer: customer.name, invoices };
    },
  }),
  createReadCapability({
    name: "get_payment_status",
    title: "Get payment status",
    description: "Whether the invoice for an order is paid, due, or refunded.",
    domain,
    intents: ["payment status", "was it paid"],
    keywords: ["payment", "paid", "status"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    execute: (input) => {
      const order = requireOrder(input);
      const invoice = getState().invoices.find((inv) => inv.orderId === order.id);
      return {
        order_id: order.id,
        invoice_id: invoice?.id ?? null,
        payment_status: invoice?.status ?? "no_invoice",
      };
    },
  }),
  createReadCapability({
    name: "get_billing_summary",
    title: "Get billing summary",
    description: "Totals of paid, due, and refunded invoices.",
    domain,
    keywords: ["billing", "summary", "outstanding"],
    routes: ["/billing"],
    inputSchema: obj({}),
    execute: () => {
      const invoices = getState().invoices;
      const sum = (status: string) =>
        Math.round(
          invoices
            .filter((inv) => inv.status === status)
            .reduce((total, inv) => total + inv.total, 0) * 100,
        ) / 100;
      return {
        invoices: invoices.length,
        paid_total: sum("paid"),
        due_total: sum("due"),
        void_total: sum("void"),
        partially_refunded_total: sum("partially_refunded"),
      };
    },
  }),
  createReadCapability({
    name: "list_credits",
    title: "List credits",
    description: "Credits and refunds issued to customers.",
    domain,
    keywords: ["credit", "refund", "issued"],
    routes: ["/billing"],
    inputSchema: obj({}),
    execute: () => {
      const credits = getState().credits;
      return { count: credits.length, credits };
    },
  }),
  createStateTransitionCapability({
    name: "issue_credit",
    title: "Issue credit",
    description: "Issue a goodwill account credit to a customer. Requires human approval.",
    domain,
    consequential: true,
    intents: ["issue credit", "goodwill credit"],
    keywords: ["credit", "goodwill", "compensate"],
    entities: ["customerId"],
    inputSchema: obj(
      {
        customer_id: s("Customer id"),
        amount: n("Credit amount in dollars"),
        reason: s("Why the credit is issued"),
      },
      ["customer_id", "amount", "reason"],
    ),
    describeApproval: (input) =>
      `Issue a ${money(Number(input.amount ?? 0))} credit to customer ${String(input.customer_id)}: ${String(input.reason ?? "")}`,
    execute: (input) => {
      const customer = requireCustomer(input);
      const amount = num(input, "amount");
      if (amount === undefined || amount <= 0) {
        throw new Error("amount must be a positive number");
      }
      const reason = requireStr(input, "reason");
      let creditId = "";
      mutate((draft) => {
        creditId = `CR-${4001 + draft.credits.length}`;
        draft.credits.push({
          id: creditId,
          customerId: customer.id,
          amount,
          reason,
          issuedAt: new Date().toISOString(),
        });
      });
      return { credit_id: creditId, customer: customer.name, amount };
    },
  }),
  createStateTransitionCapability({
    name: "refund_payment",
    title: "Refund payment",
    description:
      "Refund the full invoice for an order. Requires human approval.",
    domain,
    consequential: true,
    intents: ["refund payment", "full refund"],
    keywords: ["refund", "payment", "invoice"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    describeApproval: (input) => {
      const order = getState().orders.find(
        (o) => o.id === String(input.order_id ?? "").replace(/^#/, ""),
      );
      const invoice = order
        ? getState().invoices.find((inv) => inv.orderId === order.id)
        : undefined;
      return invoice
        ? `Refund the full ${money(invoice.total)} payment for Order #${invoice.orderId}.`
        : `Refund the payment for Order #${String(input.order_id)}.`;
    },
    execute: (input) => {
      const order = requireOrder(input);
      const invoice = getState().invoices.find((inv) => inv.orderId === order.id);
      if (!invoice || invoice.status === "void") {
        throw new CapabilityUnavailableError(
          unavailable(
            "INVALID_STATE",
            `Order ${order.id} has no refundable invoice.`,
          ),
        );
      }
      mutate((draft) => {
        const target = draft.invoices.find((inv) => inv.id === invoice.id);
        if (target) {
          target.status = "void";
        }
        draft.credits.push({
          id: `CR-${4001 + draft.credits.length}`,
          customerId: order.customerId,
          amount: invoice.total,
          reason: `Full refund for order ${order.id}`,
          issuedAt: new Date().toISOString(),
        });
      });
      return { order_id: order.id, refunded: true, amount: invoice.total };
    },
  }),
  createStateTransitionCapability({
    name: "void_invoice",
    title: "Void invoice",
    description: "Void an unpaid (due) invoice. Requires human approval.",
    domain,
    consequential: true,
    keywords: ["void", "invoice", "cancel"],
    inputSchema: obj({ invoice_id: s("Invoice id") }, ["invoice_id"]),
    describeApproval: (input) => `Void invoice ${String(input.invoice_id)}.`,
    execute: (input) => {
      const invoice = requireInvoice(input);
      if (invoice.status !== "due") {
        throw new CapabilityUnavailableError(
          unavailable(
            "INVALID_STATE",
            `Invoice ${invoice.id} is ${invoice.status}; only due invoices can be voided.`,
            invoice.status === "paid" ? "refund_payment" : undefined,
          ),
        );
      }
      mutate((draft) => {
        const target = draft.invoices.find((inv) => inv.id === invoice.id);
        if (target) {
          target.status = "void";
        }
      });
      return { invoice_id: invoice.id, status: "void" };
    },
  }),
  createUpdateCapability({
    name: "apply_discount",
    title: "Apply discount",
    description: "Apply a percentage discount to a due invoice.",
    domain,
    keywords: ["discount", "reduce", "percent"],
    inputSchema: obj(
      { invoice_id: s("Invoice id"), percent: n("Discount percent 1-50") },
      ["invoice_id", "percent"],
    ),
    execute: (input) => {
      const invoice = requireInvoice(input);
      const percent = num(input, "percent");
      if (percent === undefined || percent <= 0 || percent > 50) {
        throw new Error("percent must be between 1 and 50");
      }
      if (invoice.status !== "due") {
        throw new CapabilityUnavailableError(
          unavailable(
            "INVALID_STATE",
            `Invoice ${invoice.id} is ${invoice.status}; discounts only apply to due invoices.`,
          ),
        );
      }
      const newTotal = Math.round(invoice.total * (1 - percent / 100) * 100) / 100;
      mutate((draft) => {
        const target = draft.invoices.find((inv) => inv.id === invoice.id);
        if (target) {
          target.total = newTotal;
        }
      });
      return { invoice_id: invoice.id, percent, new_total: newTotal };
    },
  }),
  createUpdateCapability({
    name: "retry_payment",
    title: "Retry payment",
    description: "Retry collection on a due invoice and mark it paid on success.",
    domain,
    keywords: ["retry", "collect", "payment"],
    inputSchema: obj({ invoice_id: s("Invoice id") }, ["invoice_id"]),
    execute: (input) => {
      const invoice = requireInvoice(input);
      if (invoice.status !== "due") {
        throw new CapabilityUnavailableError(
          unavailable("INVALID_STATE", `Invoice ${invoice.id} is not due.`),
        );
      }
      mutate((draft) => {
        const target = draft.invoices.find((inv) => inv.id === invoice.id);
        if (target) {
          target.status = "paid";
        }
      });
      return { invoice_id: invoice.id, status: "paid" };
    },
  }),
  createReadCapability({
    name: "get_tax_summary",
    title: "Get tax summary",
    description: "Estimated tax collected on paid invoices (flat 8% demo rate).",
    domain,
    keywords: ["tax", "vat", "collected"],
    routes: ["/billing", "/reports"],
    inputSchema: obj({}),
    execute: () => {
      const paid = getState().invoices.filter((inv) => inv.status === "paid");
      const base = paid.reduce((sum, inv) => sum + inv.total, 0);
      return {
        paid_invoices: paid.length,
        taxable_base: Math.round(base * 100) / 100,
        estimated_tax: Math.round(base * 0.08 * 100) / 100,
        note: "Demo data uses a flat 8% rate.",
      };
    },
  }),
];
