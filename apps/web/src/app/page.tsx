export default function HomePage() {
  return (
    <main style={{ maxWidth: 760, margin: '64px auto', padding: '0 24px' }}>
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>AutoCompute</h1>
      <p style={{ color: '#a1a1aa', marginTop: 0 }}>
        Agent-to-agent compute marketplace PoC. Mock providers are mounted under{' '}
        <code>/api/providers/*</code>.
      </p>

      <section style={{ marginTop: 32 }}>
        <h2 style={{ fontSize: 18 }}>Mock provider endpoints</h2>
        <ul style={{ lineHeight: 1.8 }}>
          <li>
            <code>POST /api/providers/dcomp/quote</code> — quote a USDC-escrow compute job
          </li>
          <li>
            <code>POST /api/providers/dcomp/start</code> — open a job against an MPP intent hash
          </li>
          <li>
            <code>GET /api/providers/dcomp/meter?job_id=...</code> — poll meter ticks
          </li>
          <li>
            <code>POST /api/providers/dcomp/settle</code> — sign a final settlement
          </li>
          <li>
            <code>POST /api/providers/hyperscaler/quote</code> — quote a Visa-card compute job
          </li>
          <li>
            <code>POST /api/providers/hyperscaler/charge</code> — simulate a card authorization
          </li>
        </ul>
      </section>

      <p style={{ marginTop: 48, color: '#71717a', fontSize: 13 }}>
        Testnet only. No real funds, no real cards.
      </p>
    </main>
  );
}
