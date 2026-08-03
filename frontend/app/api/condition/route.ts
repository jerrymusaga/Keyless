import { keccak256 } from "viem";

/**
 * "Is this condition true right now?" — a free, instant preview of what Flare's Data Connector would
 * attest for a given request.
 *
 * The FDC verifier's `prepareResponse` runs the exact same fetch + jq transform + ABI encoding that a real
 * attestation performs, but without submitting anything: no fee, no voting round. So this is a faithful
 * answer rather than a guess, and it lets the UI show a live "true / not yet" readout while someone is
 * composing a condition — and lets a watcher avoid paying for an attestation that would fail.
 *
 * Server-side so the verifier key stays off the client. Read-only: it can only ask about an API.
 */
export const runtime = "nodejs";
export const maxDuration = 30;

const VERIFIER_URL = (process.env.VERIFIER_URL || "https://fdc-verifiers-testnet.flare.network").replace(/\/$/, "");
// Flare's public, rate-limited testnet verifier key (dev.flare.network/fdc/getting-started).
const VERIFIER_API_KEY = process.env.VERIFIER_API_KEY || "00000000-0000-0000-0000-000000000000";
const ATT_TYPE = "Web2Json";
const SOURCE_ID = "PublicWeb2";
/** keccak(abi.encode(true)) — every condition's jq yields a bool, so this is what "satisfied" looks like. */
const EXPECTED_TRUE = "0xb10e2d527612073b26eecdfd717e6a320cf44b4afac2b0732d9fcbe2b7fa0cf6";

const type32 = (s: string) => `0x${Buffer.from(s, "utf8").toString("hex").padEnd(64, "0")}`;

export async function POST(req: Request) {
  let request: Record<string, string> | undefined;
  try {
    ({ request } = await req.json());
  } catch {
    return Response.json({ error: "bad request" }, { status: 400 });
  }
  if (!request?.url || !request.postProcessJq) {
    return Response.json({ error: "missing request" }, { status: 400 });
  }

  try {
    const res = await fetch(`${VERIFIER_URL}/verifier/web2/${ATT_TYPE}/prepareResponse`, {
      method: "POST",
      headers: { "X-API-KEY": VERIFIER_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ attestationType: type32(ATT_TYPE), sourceId: type32(SOURCE_ID), requestBody: request }),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (body?.status !== "VALID") {
      // INVALID here almost always means the API couldn't be fetched or the transform didn't apply.
      return Response.json({ error: `the API couldn't be read (${body?.status ?? res.status})` }, { status: 502 });
    }
    const attested = body.response?.responseBody?.abiEncodedData as `0x${string}` | undefined;
    if (!attested) return Response.json({ error: "verifier returned no data" }, { status: 502 });
    return Response.json({ ok: keccak256(attested) === EXPECTED_TRUE, attested });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}
