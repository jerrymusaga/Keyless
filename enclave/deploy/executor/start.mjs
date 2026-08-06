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

// Inherit stdio so the watcher's logs are the service's logs, and forward its exit code so Railway
// restarts on a genuine crash rather than treating it as a clean stop.
const child = spawn(process.execPath, [picked.script, "watch"], { stdio: "inherit" });
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
