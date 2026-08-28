import { StatCard, fmtMoney } from "../components/bits.tsx";
import { useDemoStore } from "../components/hooks.ts";
import { round2 } from "../data/types.ts";

export function Inventory() {
  const state = useDemoStore();
  const products = state.products;
  const low = products.filter(
    (p) => !p.discontinued && p.stock - p.reserved <= p.reorderPoint,
  );
  const valuation = round2(
    products.filter((p) => !p.discontinued).reduce((sum, p) => sum + p.stock * p.price, 0),
  );

  return (
    <>
      <h1>Inventory</h1>
      <p className="page-sub">{products.length} SKUs tracked.</p>
      <div className="cards">
        <StatCard label="Units on hand" value={products.reduce((s, p) => s + p.stock, 0)} />
        <StatCard label="Reserved" value={products.reduce((s, p) => s + p.reserved, 0)} />
        <StatCard label="Low stock" value={low.length} hint="at or below reorder point" />
        <StatCard label="Valuation" value={fmtMoney(valuation)} hint="at list price" />
      </div>
      <div className="panel">
        <table className="data">
          <thead>
            <tr>
              <th>SKU</th>
              <th>Product</th>
              <th>Category</th>
              <th>Price</th>
              <th>Stock</th>
              <th>Reserved</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.sku}>
                <td>{product.sku}</td>
                <td>{product.name}</td>
                <td>{product.category}</td>
                <td>{fmtMoney(product.price)}</td>
                <td>{product.stock}</td>
                <td>{product.reserved}</td>
                <td>
                  {product.discontinued ? (
                    <span className="pill cancelled">discontinued</span>
                  ) : product.stock - product.reserved <= product.reorderPoint ? (
                    <span className="pill pending">low stock</span>
                  ) : (
                    <span className="pill paid">in stock</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
