/**
 * Minimal read-only XRPL Testnet client. The Keyless account is a normal XRPL account, so its balance
 * and history come straight from the public ledger.
 *
 * Reads go through our same-origin /api/xrpl route rather than an XRPL node directly: the public XRPL
 * cluster has no browser CORS headers and uses a non-standard port many networks block, so a direct
 * client fetch silently fails. The server route proxies to a browser-safe node.
 */
const XRPL_PROXY = "/api/xrpl";

export type XrplBalance = { funded: boolean; drops: bigint };

export async function getXrplBalance(address: string): Promise<XrplBalance> {
  const res = await fetch(XRPL_PROXY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: address, kind: "info" }),
    cache: "no-store",
  });
  const body = await res.json();
  const status = body?.result?.status;
  const err = body?.result?.error;
  if (status === "error") {
    // actNotFound => the account exists but has never been funded (no reserve yet)
    if (err === "actNotFound") return { funded: false, drops: 0n };
    throw new Error(err ?? "xrpl error");
  }
  const drops = body?.result?.account_data?.Balance ?? "0";
  return { funded: true, drops: BigInt(drops) };
}

export type XrplTx = { hash: string; amountDrops: bigint; destination: string; outgoing: boolean; date: number };

export async function getRecentPayments(address: string, limit = 8): Promise<XrplTx[]> {
  const res = await fetch(XRPL_PROXY, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: address, kind: "tx", limit }),
    cache: "no-store",
  });
  const body = await res.json();
  const rows = body?.result?.transactions ?? [];
  const out: XrplTx[] = [];
  for (const r of rows) {
    const t = r.tx ?? r.tx_json ?? {};
    if (t.TransactionType !== "Payment") continue;
    if (typeof t.Amount !== "string") continue; // skip non-XRP (IOU) payments
    out.push({
      hash: t.hash,
      amountDrops: BigInt(t.Amount),
      destination: t.Destination,
      outgoing: t.Account?.toLowerCase() === address.toLowerCase(),
      date: t.date ?? 0,
    });
  }
  return out;
}
