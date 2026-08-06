/**
 * Read-only XRPL Testnet proxy. The dashboard reads each Keyless account's balance and history straight
 * from the public ledger — but the XRPL public cluster (s.altnet.rippletest.net:51234) is unreliable
 * from browsers: no CORS headers, and a non-standard port that many networks block. So we read it on the
 * server (no CORS, uncached) and hand back plain JSON, exactly like /api/chain does for Coston2.
 *
 * Upstream is overridable via XRPL_RPC_URL; the default is the browser-friendly XRPL Labs testnet node.
 */
export const runtime = "nodejs";

/**
 * Several upstreams, tried in order — a single node is a single point of failure, and testnet nodes go
 * out regularly. Observed live: xrpl-labs answering `noNetwork` (its node desynced) while s.altnet served
 * the same query fine, which left balances stuck on a loading state forever. The browser-hostility that
 * originally pushed us off s.altnet (no CORS, non-standard port) doesn't apply here — we call it from the
 * server. XRPL_RPC_URL still wins if set.
 */
const XRPL_RPCS = [
  process.env.XRPL_RPC_URL,
  "https://s.altnet.rippletest.net:51234/",
  "https://testnet.xrpl-labs.com/",
].filter(Boolean) as string[];

/** An upstream that is up but not serving (desynced node, gateway error) — try the next one. */
function isUpstreamFailure(json: unknown): boolean {
  const r = (json as { result?: { status?: string; error?: string } })?.result;
  if (!r) return true;
  // `actNotFound` is a real answer (an unfunded account), not a failure — don't fall through on it.
  return r.status === "error" && r.error !== "actNotFound";
}

export async function POST(req: Request) {
  let account: string;
  let kind: "info" | "tx";
  let limit: number | undefined;
  try {
    ({ account, kind, limit } = await req.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!account || typeof account !== "string") {
    return Response.json({ error: "missing account" }, { status: 400 });
  }

  const body =
    kind === "tx"
      ? {
          method: "account_tx",
          params: [{ account, ledger_index_min: -1, ledger_index_max: -1, binary: false, limit: limit ?? 8 }],
        }
      : { method: "account_info", params: [{ account, ledger_index: "validated" }] };

  let lastError = "no upstream tried";
  for (const rpc of XRPL_RPCS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const json = await res.json();
      if (isUpstreamFailure(json)) {
        lastError = `${new URL(rpc).host}: ${(json as { result?: { error?: string } })?.result?.error ?? res.status}`;
        continue;
      }
      return Response.json(json);
    } catch (e) {
      lastError = `${new URL(rpc).host}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return Response.json({ error: `no XRPL node answered (${lastError})` }, { status: 502 });
}
