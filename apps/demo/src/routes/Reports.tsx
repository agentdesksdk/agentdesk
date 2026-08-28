import { StatCard, fmtMoney } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";
import { orderTotal, round2 } from "../data/types.ts";

export function Reports() {
  const state = useDemoStore();
  const active = state.orders.filter((o) => o.status !== "cancelled");
  const revenue = round2(active.reduce((sum, o) => sum + orderTotal(o), 0));
  const shippingCharged = round2(
    active.filter((o) => o.shippingPaid).reduce((sum, o) => sum + o.shippingFee, 0),
  );
  const shippingRefunded = round2(
    active.filter((o) => o.shippingRefunded).reduce((sum, o) => sum + o.shippingFee, 0),
  );

  const units = new Map<string, { name: string; units: number }>();
  for (const order of active) {
    for (const item of order.items) {
      const entry = units.get(item.sku) ?? { name: item.name, units: 0 };
      entry.units += item.quantity;
      units.set(item.sku, entry);
    }
  }
  const top = [...units.entries()]
    .map(([sku, entry]) => ({ sku, ...entry }))
    .sort((a, b) => b.units - a.units)
    .slice(0, 6);

  const statuses = ["processing", "on_hold", "shipped", "delivered", "cancelled"];

  return (
    <>
      <h1>Reports</h1>
      <p className="page-sub">
        Headline metrics computed live from the in-browser dataset.
      </p>
      <div className="cards">
        <StatCard label="Revenue" value={fmtMoney(revenue)} />
        <StatCard label="Shipping charged" value={fmtMoney(shippingCharged)} />
        <StatCard label="Shipping refunded" value={fmtMoney(shippingRefunded)} />
        <StatCard
          label="Avg order value"
          value={fmtMoney(active.length > 0 ? round2(revenue / active.length) : 0)}
        />
      </div>
      <div className="grid-2">
        <div className="panel">
          <h2>Orders by status</h2>
          <table className="data">
            <tbody>
              {statuses.map((status) => (
                <tr key={status}>
                  <td>{status.replace(/_/g, " ")}</td>
                  <td>{state.orders.filter((o) => o.status === status).length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h2>Top products by units</h2>
          <table className="data">
            <thead>
              <tr>
                <th>Product</th>
                <th>Units</th>
              </tr>
            </thead>
            <tbody>
              {top.map((product) => (
                <tr key={product.sku}>
                  <td>
                    {product.name}
                    <div className="est">{product.sku}</div>
                  </td>
                  <td>{product.units}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
