export function DurabilityCard({ orderId }: { orderId: string }) {
  return (
    <div
      className="panel durability-card"
      role="region"
      aria-label={`Interrupted operations on order #${orderId}`}
    >
      <h2>Interrupt and recover</h2>
      <button type="button" aria-label={`Interrupt a shipping refund on order #${orderId}`}>
        Interrupt a refund
      </button>
      <p data-durability-result></p>
    </div>
  );
}
