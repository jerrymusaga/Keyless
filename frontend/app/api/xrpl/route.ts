/**
 * Read-only XRPL Testnet proxy. The dashboard reads each Keyless account's balance and history straight
 * from the public ledger — but the XRPL public cluster (s.altnet.rippletest.net:51234) is unreliable
 * from browsers: no CORS headers, and a non-standard port that many networks block. So we read it on the
 * server (no CORS, uncached) and hand back plain JSON, exactly like /api/chain does for Coston2.
 *
 * Upstream is overridable via XRPL_RPC_URL; the default is the browser-friendly XRPL Labs testnet node.
 */
export const runtime = "nodejs";

const XRPL_RPC = process.env.XRPL_RPC_URL || "https://testnet.xrpl-labs.com/";

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

  try {
    const res = await fetch(XRPL_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const json = await res.json();
    return Response.json(json);
  } catch (e) {
    return Response.json(
      { error: `xrpl upstream unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
