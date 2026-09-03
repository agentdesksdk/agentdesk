import {
  AVAILABLE,
  CapabilityUnavailableError,
  unavailable,
  type Capability,
  type Unavailability,
  receipt,
} from "@agentdesksdk/webmcp";
import { getState, mutate, nowIso } from "../data/store.ts";
import {
  createReadCapability,
  createStateTransitionCapability,
  createUpdateCapability,
} from "./factories.ts";
import {
  customerRoute,
  money,
  num,
  obj,
  orderRoute,
  requireCustomer,
  requireOrder,
  requireStr,
  s,
  n,
} from "./helpers.ts";

const domain = "billing";

function orderFromInput(input: Record<string, unknown>) {
  const id =
    typeof input.order_id === "string" || typeof input.order_id === "number"
      ? String(input.order_id).replace(/^#/, "")
      : undefined;
  return id !== undefined
    ? getState().orders.find((o) => o.id === id)
    : undefined;
}

/**
 * Collected funds minus credits already issued against this order
 * (currently the shipping refund). Refunds must never exceed this.
 */
function refundableBalance(
  input: Record<string, unknown>,
): { orderId: string; amount: number } | null {
  const order = orderFromInput(input);
  const invoice = order
    ? getState().invoices.find((inv) => inv.orderId === order.id)
    : undefined;
  if (!order || !invoice) {
    return null;
  }
  if (invoice.status !== "paid" && invoice.status !== "partially_refunded") {
    return null;
  }
  const priorCredits = order.shippingRefunded ? order.shippingFee : 0;
  return {
    orderId: order.id,
    amount: Math.max(0, Math.round((invoice.total - priorCredits) * 100) / 100),
  };
}

function refundPaymentBlocker(
  input: Record<string, unknown>,
): Unavailability | null {
  const order = orderFromInput(input);
  if (!order) {
    return null;
  }
  const invoice = getState().invoices.find((inv) => inv.orderId === order.id);
  if (!invoice) {
    return unavailable("INVALID_STATE", `Order ${order.id} has no invoice.`);
  }
  if (invoice.status === "due") {
    return unavailable(
      "PAYMENT_NOT_COLLECTED",
      `Invoice ${invoice.id} is still due; there is no collected payment to refund.`,
      "void_invoice",
    );
  }
  if (invoice.status === "void") {
    return unavailable("INVALID_STATE", `Invoice ${invoice.id} is already void.`);
  }
  const refundable = refundableBalance(input);
  if (!refundable || refundable.amount <= 0) {
    return unavailable(
      "ALREADY_REFUNDED",
      `The collected balance for order ${order.id} has already been fully credited.`,
    );
  }
  return null;
}

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
    // Mints a credit id from the number of existing credits, so a branch
    // prepared before the human issued one would mint a duplicate. Re-derive
    // against current state at approval instead of merging the stale write.
    commitMode: "rederive",
    intents: ["issue credit", "goodwill credit", "apply customer credit"],
    keywords: ["credit", "customer", "goodwill", "compensate"],
    entities: ["customerId"],
    inputSchema: obj(
      {
        customer_id: s("Customer id"),
        amount: n("Credit amount in dollars"),
        reason: s("Why the credit is issued"),
      },
      ["customer_id", "amount", "reason"],
    ),
    presentation: {
      route: (input) => customerRoute(input),
      reveal: "customer-credits",
      message: (input) =>
        `Preparing a ${money(Number(input.amount ?? 0))} credit for ${String(input.customer_id ?? "")}`,
    },
    checkInput: (input) => {
      const amount =
        typeof input.amount === "number" && Number.isFinite(input.amount)
          ? input.amount
          : undefined;
      const customerId =
        typeof input.customer_id === "string" && input.customer_id.trim() !== ""
          ? input.customer_id.trim()
          : undefined;
      if (amount === undefined || amount <= 0 || customerId === undefined) {
        return unavailable(
          "INVALID_INPUT",
          "customer_id and a positive amount are required before requesting approval.",
        );
      }
      const exists = getState().customers.some(
        (c) =>
          c.id === customerId ||
          c.name.toLowerCase() === customerId.toLowerCase(),
      );
      if (!exists) {
        return unavailable(
          "MISSING_CUSTOMER",
          `No customer ${customerId} exists.`,
          "search_customers",
        );
      }
      return AVAILABLE;
    },
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
          issuedAt: nowIso(),
        });
      });
      return receipt({
        entity: `Customer ${customer.name}`,
        changes: [
          { field: "Credit issued", before: null, after: `${creditId} · ${money(amount)}` },
        ],
        evidence: [
          {
            label: `Credit ${creditId} for ${customer.name}`,
            route: `/customers/${customer.id}`,
            reveal: "customer-credits",
          },
        ],
        result: { credit_id: creditId, customer: customer.name, amount },
      });
    },
  }),
  createStateTransitionCapability({
    name: "refund_payment",
    title: "Refund payment",
    description:
      "Refund the remaining collected balance of an order's invoice. Requires human approval.",
    domain,
    consequential: true,
    // Mints a credit id from the number of existing credits, so a branch
    // prepared before the human issued one would mint a duplicate. Re-derive
    // against current state at approval instead of merging the stale write.
    commitMode: "rederive",
    intents: ["refund payment", "full refund"],
    keywords: ["refund", "payment", "invoice"],
    entities: ["orderId"],
    inputSchema: obj({ order_id: s("Order id") }, ["order_id"]),
    presentation: {
      route: orderRoute,
      reveal: "order-billing",
      message: (input) =>
        `Preparing a payment refund for order #${String(input.order_id ?? "")}`,
    },
    checkInput: (input) => refundPaymentBlocker(input) ?? AVAILABLE,
    describeApproval: (input) => {
      const refundable = refundableBalance(input);
      return refundable
        ? `Refund the remaining ${money(refundable.amount)} collected for Order #${refundable.orderId}.`
        : `Refund the payment for Order #${String(input.order_id)}.`;
    },
    execute: (input) => {
      const order = requireOrder(input);
      const blocker = refundPaymentBlocker(input);
      if (blocker) {
        throw new CapabilityUnavailableError(blocker);
      }
      const refundable = refundableBalance(input)!;
      const invoiceBefore = getState().invoices.find((inv) => inv.orderId === order.id);
      let creditId = "";
      mutate((draft) => {
        const target = draft.invoices.find((inv) => inv.orderId === order.id);
        if (target) {
          target.status = "void";
        }
        creditId = `CR-${4001 + draft.credits.length}`;
        draft.credits.push({
          id: creditId,
          customerId: order.customerId,
          amount: refundable.amount,
          reason: `Refund of collected balance for order ${order.id}`,
          issuedAt: nowIso(),
        });
      });
      return receipt({
        entity: `Order #${order.id}`,
        changes: [
          ...(invoiceBefore
            ? [
                {
                  field: `Invoice ${invoiceBefore.id} status`,
                  before: invoiceBefore.status,
                  after: "void",
                },
              ]
            : []),
          {
            field: "Credit issued",
            before: null,
            after: `${creditId} · ${money(refundable.amount)}`,
          },
        ],
        evidence: [
          {
            label: `Invoice status on Order #${order.id}`,
            route: `/orders/${order.id}`,
            reveal: "order-billing",
          },
          {
            label: `Credit ${creditId} for customer ${order.customerId}`,
            route: `/customers/${order.customerId}`,
            reveal: "customer-credits",
          },
        ],
        result: { order_id: order.id, refunded: true, amount: refundable.amount },
      });
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
      return receipt({
        entity: `Invoice ${invoice.id}`,
        changes: [
          { field: `Invoice ${invoice.id} status`, before: invoice.status, after: "void" },
        ],
        evidence: [
          {
            label: `Invoice ${invoice.id} status on Order #${invoice.orderId}`,
            route: `/orders/${invoice.orderId}`,
            reveal: "order-billing",
          },
          {
            label: `Invoice ${invoice.id} in the invoice list`,
            route: "/billing",
            reveal: "invoices-table",
          },
        ],
        result: { invoice_id: invoice.id, status: "void" },
      });
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
      return receipt({
        entity: `Invoice ${invoice.id}`,
        changes: [
          {
            field: `Invoice ${invoice.id} total`,
            before: invoice.total,
            after: newTotal,
          },
        ],
        undoable: false,
        result: { invoice_id: invoice.id, percent, new_total: newTotal },
      });
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
