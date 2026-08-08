// Service entrypoint.
//
// Several watchers live in this folder and Railway runs `npm start`, so a service picks which one it is
// with the WATCHER env var. Deploy this same root once per watcher rather than maintaining near-identical
// services:
//
//   WATCHER=mint         (default)  completes FXRP direct mints          -> executor.mjs watch
//   WATCHER=conditional             proves Conditional-policy releases   -> conditional.mjs watch
//   WATCHER=scheduled               runs standing orders as they fall due -> scheduled.mjs watch
//
// All need EXECUTOR_KEY (a funded Coston2 key). The first two pay a small FDC attestation fee per job (the
// mint watcher earns the executor fee back, so it is roughly self-funding); the scheduled watcher pays
// only gas and the per-instruction fee.

import { spawn } from "node:child_process";
import { createPublicClient, http, defineChain, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const WATCHERS = {
  mint: { script: "executor.mjs", what: "FXRP mints" },
  conditional: { script: "conditional.mjs", what: "Conditional-policy releases" },
  scheduled: { script: "scheduled.mjs", what: "scheduled payments falling due" },
};

const which = (process.env.WATCHER || "mint").trim().toLowerCase();
const picked = WATCHERS[which];

if (!picked) {
  console.error(`WATCHER="${which}" is not one of: ${Object.keys(WATCHERS).join(", ")}`);
  process.exit(1);
}
if (!process.env.EXECUTOR_KEY) {
  console.error("set EXECUTOR_KEY (a funded Coston2 key) — the watcher pays the FDC attestation fee + gas");
  process.exit(1);
}

console.log(`[start] WATCHER=${which} — watching for ${picked.what}`);

/**
 * Say who we are and what we can afford, on every boot.
 *
 * A watcher that runs out of gas fails at the worst possible moment — when a payment finally comes due —
 * and the error it produces ("the total cost of executing this transaction exceeds the balance") names the
 * executor account without ever printing it, so there is nothing to go and top up. Logging the address and
 * balance at startup turns a silent countdown into something you can see, and the warning fires long before
 * the first missed payment rather than after it.
 */
const LOW_BALANCE = 10n ** 18n; // 1 C2FLR — hundreds of instructions, but a clear floor to act on
try {
  const coston2 = defineChain({
    id: 114, name: "Coston2",
    nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
    rpcUrls: { default: { http: [process.env.RPC_URL || "https://coston2-api.flare.network/ext/C/rpc"] } },
  });
  const key = process.env.EXECUTOR_KEY;
  const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
  const pub = createPublicClient({ chain: coston2, transport: http() });
  const balance = await pub.getBalance({ address: account.address });
  console.log(`[start] executor ${account.address} — ${formatEther(balance)} C2FLR`);
  if (balance < LOW_BALANCE) {
    console.warn(`[start] ⚠ LOW BALANCE — top this address up with C2FLR or payments will start failing.`);
    console.warn(`[start]   Coston2 faucet: https://faucet.flare.network/coston2`);
  }
} catch (e) {
  console.warn(`[start] couldn't read the executor balance: ${e.shortMessage || e.message}`);
}

// Inherit stdio so the watcher's logs are the service's logs, and forward its exit code so Railway
// restarts on a genuine crash rather than treating it as a clean stop.
const child = spawn(process.execPath, [picked.script, "watch"], { stdio: "inherit" });

// A shutdown we were asked for is not a failure. SIGTERM is exactly how Railway stops a service on
// redeploy, so exiting non-zero on it would make every ordinary deploy look like a crash — and with an
// ON_FAILURE restart policy, invite a restart loop. Anything else (a crash signal, a non-zero exit) is
// still reported honestly so the platform brings the watcher back.
const requested = new Set(["SIGTERM", "SIGINT"]);
for (const sig of requested) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => {
  if (signal && requested.has(signal)) return process.exit(0);
  process.exit(signal ? 1 : (code ?? 0));
});
