import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "./components/AppShell.tsx";
import { Benchmark } from "./routes/Benchmark.tsx";
import { Billing } from "./routes/Billing.tsx";
import { CustomerDetail } from "./routes/CustomerDetail.tsx";
import { Customers } from "./routes/Customers.tsx";
import { Inventory } from "./routes/Inventory.tsx";
import { OrderDetail } from "./routes/OrderDetail.tsx";
import { Orders } from "./routes/Orders.tsx";
import { Overview } from "./routes/Overview.tsx";
import { Reports } from "./routes/Reports.tsx";
import { Shipping } from "./routes/Shipping.tsx";
import { Support } from "./routes/Support.tsx";
import { SupportTicket } from "./routes/SupportTicket.tsx";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/agentdesk" replace />} />
      <Route path="/:mode" element={<AppShell />}>
        <Route index element={<Overview />} />
        <Route path="customers" element={<Customers />} />
        <Route path="customers/:id" element={<CustomerDetail />} />
        <Route path="orders" element={<Orders />} />
        <Route path="orders/:id" element={<OrderDetail />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="shipping" element={<Shipping />} />
        <Route path="billing" element={<Billing />} />
        <Route path="support" element={<Support />} />
        <Route path="support/:id" element={<SupportTicket />} />
        <Route path="reports" element={<Reports />} />
        <Route path="benchmark" element={<Benchmark />} />
        <Route path="*" element={<Navigate to="." replace />} />
      </Route>
    </Routes>
  );
}
