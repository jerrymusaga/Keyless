import { useState } from "react";
import { createPublicClient, http } from "viem";
import { COSTON2, ADDRESSES, DEMO_POLICY_ABI } from "./config.js";

/**
 * Keyless demo UI — SKELETON.
 *
 * This is intentionally minimal: a starting point to build the demo interface on in Claude Code.
 * The structure mirrors the demo beat:
 *   1. Show the policy is bound (isBound).
 *   2. Pay an allowlisted recipient  → succeeds (real XRP moves via PMW).
 *   3. Try to pay a non-allowlisted recipient → the contract reverts. This is the point.
 *
 * TODO for the build:
 *   - Wallet connection (injected / WalletConnect) for write calls.
 *   - Wire pay() and show the returned paymentId + XRPL explorer link.
 *   - Show the revert reason inline when paying a non-allowlisted address (the "cheat fails" beat).
 *   - Optional: poll payment status if PMW turns out to be async (OPEN_ITEMS #1).
 */

const client = createPublicClient({
  chain: {
    id: COSTON2.chainId,
    name: "Coston2",
    nativeCurrency: { name: "C2FLR", symbol: "C2FLR", decimals: 18 },
    rpcUrls: { default: { http: [COSTON2.rpc] } },
  },
  transport: http(COSTON2.rpc),
});

export default function App() {
  const [bound, setBound] = useState(null);
  const [recipient, setRecipient] = useState("");
  const [status, setStatus] = useState("");

  async function checkBound() {
    if (ADDRESSES.demoPolicy.startsWith("0x0000")) {
      setStatus("Set ADDRESSES.demoPolicy in src/config.js after deploying.");
      return;
    }
    try {
      const result = await client.readContract({
        address: ADDRESSES.demoPolicy,
        abi: DEMO_POLICY_ABI,
        functionName: "isBound",
      });
      setBound(result);
      setStatus(result ? "Policy is the account's authorization address." : "Policy not yet bound (see OPEN_ITEMS #2).");
    } catch (e) {
      setStatus("Read failed: " + (e.shortMessage ?? String(e)));
    }
  }

  return (
    <main style={styles.main}>
      <header style={styles.header}>
        <h1 style={styles.h1}>Keyless</h1>
        <p style={styles.tagline}>
          An XRPL account that can only pay what an on-chain policy permits. The operator holds no key.
        </p>
      </header>

      <section style={styles.card}>
        <h2 style={styles.h2}>1 · Is the policy in control?</h2>
        <button style={styles.btn} onClick={checkBound}>Check binding</button>
        {bound !== null && (
          <p style={{ color: bound ? "#2a7" : "#c73" }}>
            isBound() → {String(bound)}
          </p>
        )}
      </section>

      <section style={styles.card}>
        <h2 style={styles.h2}>2 · Pay a recipient</h2>
        <input
          style={styles.input}
          placeholder="XRPL r-address"
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
        />
        <p style={styles.hint}>
          Allowlisted → PMW authorizes the payment. Not allowlisted → the contract reverts.
          Wiring the write call + revert display is the next build step.
        </p>
      </section>

      {status && <p style={styles.status}>{status}</p>}

      <footer style={styles.footer}>
        Coston2 · PMW {ADDRESSES.teePaymentsFXRP.slice(0, 10)}… · see docs/ for architecture &amp; open items
      </footer>
    </main>
  );
}

const styles = {
  main: { maxWidth: 620, margin: "0 auto", padding: "48px 20px", fontFamily: "system-ui, sans-serif", color: "#1a1a1a" },
  header: { marginBottom: 32 },
  h1: { fontSize: 40, margin: 0, letterSpacing: -1 },
  tagline: { color: "#555", fontSize: 16, marginTop: 8 },
  card: { border: "1px solid #e3e3e3", borderRadius: 12, padding: 20, marginBottom: 16 },
  h2: { fontSize: 15, textTransform: "uppercase", letterSpacing: 0.5, color: "#666", margin: "0 0 12px" },
  btn: { background: "#111", color: "#fff", border: 0, borderRadius: 8, padding: "10px 16px", cursor: "pointer", fontSize: 14 },
  input: { width: "100%", padding: 10, borderRadius: 8, border: "1px solid #ccc", fontSize: 14, boxSizing: "border-box" },
  hint: { color: "#888", fontSize: 13, marginTop: 10 },
  status: { background: "#f5f5f5", borderRadius: 8, padding: 12, fontSize: 13, color: "#333" },
  footer: { marginTop: 40, color: "#aaa", fontSize: 12 },
};
