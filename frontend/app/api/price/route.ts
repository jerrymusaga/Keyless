/**
 * XRP spot price, for display only.
 *
 * Amounts in Keyless are denominated and enforced in XRP, deliberately: a cap's whole job is to be an
 * absolute bound, and a bound that moves with the market isn't one. Denominating in dollars would put an
 * oracle inside the guarantee — if the price fell, more XRP could leave for the same "limit", and the
 * worst case would stop being statable.
 *
 * But people think in dollars. So the conversion lives out here, at the very edge: it decorates a number
 * the contract already fixed, and if this route fails the UI simply omits the hint. Nothing about an
 * account's safety touches this file.
 *
 * Coinbase rather than CoinGecko for the same reason the Conditional templates use it — CoinGecko's free
 * tier throttles aggressively.
 */
export const runtime = "nodejs";
export const revalidate = 60;

export async function GET() {
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/XRP-USD/spot", {
      next: { revalidate: 60 },
      headers: { accept: "application/json" },
    });
    if (!res.ok) return Response.json({ error: "price unavailable" }, { status: 502 });
    const body = await res.json();
    const usd = Number(body?.data?.amount);
    if (!Number.isFinite(usd) || usd <= 0) return Response.json({ error: "price unavailable" }, { status: 502 });
    return Response.json({ usd });
  } catch {
    return Response.json({ error: "price unavailable" }, { status: 502 });
  }
}
