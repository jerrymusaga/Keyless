/**
 * Minimal read-only XRPL Testnet client. The Keyless account is a normal XRPL account, so its balance
 * and history come straight from the public ledger — no enclave, no Keyless server in the path.
 */
const XRPL_TESTNET_RPC = "https://s.altnet.rippletest.net:51234/";

export type XrplBalance = { funded: boolean; drops: bigint };

export async function getXrplBalance(address: string): Promise<XrplBalance> {
  const res = await fetch(XRPL_TESTNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "account_info",
      params: [{ account: address, ledger_index: "validated" }],
    }),
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
  const res = await fetch(XRPL_TESTNET_RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: "account_tx",
      params: [{ account: address, ledger_index_min: -1, ledger_index_max: -1, binary: false, limit }],
    }),
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
