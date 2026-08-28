export type OrderStatus =
  | "processing"
  | "on_hold"
  | "shipped"
  | "delivered"
  | "cancelled";

export type Customer = {
  id: string;
  name: string;
  email: string;
  phone: string;
  city: string;
  country: string;
  segment: "consumer" | "business";
  createdAt: string;
  tags: string[];
  notes: string[];
};

export type OrderItem = {
  sku: string;
  name: string;
  quantity: number;
  unitPrice: number;
};

export type Order = {
  id: string;
  customerId: string;
  placedAt: string;
  status: OrderStatus;
  items: OrderItem[];
  shippingFee: number;
  shippingPaid: boolean;
  shippingRefunded: boolean;
  shippingAddress: string;
  carrier: string;
  trackingNumber: string | null;
  holdReason: string | null;
  notes: string[];
  tags: string[];
};

export type Product = {
  sku: string;
  name: string;
  category: string;
  price: number;
  stock: number;
  reserved: number;
  reorderPoint: number;
  discontinued: boolean;
};

export type TicketMessage = {
  from: "customer" | "agent";
  text: string;
  at: string;
};

export type Ticket = {
  id: string;
  customerId: string;
  subject: string;
  status: "open" | "pending" | "closed";
  priority: "low" | "normal" | "high";
  createdAt: string;
  messages: TicketMessage[];
};

export type Credit = {
  id: string;
  customerId: string;
  amount: number;
  reason: string;
  issuedAt: string;
};

export type Invoice = {
  id: string;
  orderId: string;
  customerId: string;
  total: number;
  status: "paid" | "due" | "void" | "partially_refunded";
  issuedAt: string;
};

export type DemoState = {
  customers: Customer[];
  orders: Order[];
  products: Product[];
  tickets: Ticket[];
  credits: Credit[];
  invoices: Invoice[];
};

export function orderTotal(order: Order): number {
  const items = order.items.reduce(
    (sum, item) => sum + item.quantity * item.unitPrice,
    0,
  );
  return round2(items + (order.shippingPaid ? order.shippingFee : 0));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
