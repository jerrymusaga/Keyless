"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useKeyless } from "@/components/app/KeylessProvider";
import { Button, Card, Copy, Field, Input, Notice, Spinner } from "@/components/app/ui";
import { addAccount } from "@/lib/accounts";
import {
  ADDRESSES,
  ACCOUNTS_ABI,
  INIT_FEE,
  POLICY_SLOTS,
  RULES,
  RULE_META,
  ZERO_ADDRESS,
  type PolicySlot,
  type RuleKey,
} from "@/lib/keyless";
import { publicClient } from "@/lib/clients";
import { toHex } from "viem";

/**
 * One policy, led by the question it answers. The rule's name is demoted to a footer label — still there
 * so it matches what you'll see on the account afterwards, but it isn't what you choose by.
 */
function PolicyCard({
  slot,
  selected,
  onSelect,
}: {
  slot: PolicySlot;
  selected: RuleKey;
  onSelect: (r: RuleKey) => void;
}) {
  const meta = slot.rule ? RULE_META[slot.rule] : undefined;
  const copy = meta ?? slot.soon!;
  const disabled = !slot.rule || (RULES[slot.rule] as string) === ZERO_ADDRESS || !!meta?.comingSoon;
  const active = !!slot.rule && selected === slot.rule;

  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={active}
      onClick={() => slot.rule && onSelect(slot.rule)}
      className={`flex h-full flex-col rounded-xl border p-4 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
        active ? "border-signal-500/60 bg-signal-500/5" : "hairline bg-ink-900/60 hover:border-ink-600"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[15px] font-medium leading-snug text-mist-100">{slot.question}</span>
        {disabled ? (
          <span className="mt-0.5 shrink-0 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-200/90">
            Soon
          </span>
        ) : (
          active && <span className="mt-0.5 shrink-0 text-signal-400">✓</span>
        )}
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-mist-400">{copy.tagline}</p>
      <p className="mt-2 text-[11px] leading-relaxed text-mist-500">
        <span className="text-mist-400">Good for:</span> {copy.useFor}
      </p>
      <span className="mt-3 pt-2 text-[10px] uppercase tracking-[0.16em] text-mist-500">{copy.name}</span>
    </button>
  );
}

export default function NewAccount() {
  const router = useRouter();
  const { status, address, write, ensureFunded } = useKeyless();
  const [label, setLabel] = useState("");
  const [rule, setRule] = useState<RuleKey>("exchange");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gasHelp, setGasHelp] = useState<string | null>(null); // Flare faucet URL when auto-funding is off

  if (status !== "ready" || !address) {
    return (
      <Notice tone="info">
        You need a Keyless wallet first. <a className="underline" href="/app">Go back</a> and create one.
      </Notice>
    );
  }

  const create = async () => {
    setError(null);
    setGasHelp(null);
    if (!label.trim()) return setError("Give your account a name first — it's how you'll tell your accounts apart.");
    try {
      // 0. make sure the control key can pay gas + the INIT fee. If the gas sponsor is off (no
      // FAUCET_KEY) or dry, don't barrel into createWallet and fail on gas — point the user at the
      // public Flare faucet to top up their own control key, then retry.
      setBusy("Funding your control key…");
      const funded = await ensureFunded();
      if (!funded.ok) {
        setBusy(null);
        setGasHelp(funded.faucet ?? "https://faucet.flare.network/coston2");
        return;
      }

      // 1. deterministic salt + walletId
      const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
      const walletId = (await publicClient.readContract({
        address: ADDRESSES.accounts,
        abi: ACCOUNTS_ABI,
        functionName: "walletIdFor",
        args: [address, salt],
      })) as `0x${string}`;

      // 2. createWallet — this sends the INIT that makes the enclave generate the XRPL key.
      // The updated scaffold dropped on-chain fee quoting; attach a fixed INIT_FEE (excess refunds).
      setBusy("Creating your account (generating a key inside the enclave)…");
      await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "createWallet", args: [salt], value: INIT_FEE });
      addAccount(address, { walletId, label: label.trim(), salt, createdAt: Date.now() });

      // 3. point it at the chosen rule
      setBusy("Applying your policy…");
      await write({ address: ADDRESSES.accounts, abi: ACCOUNTS_ABI, functionName: "setRule", args: [walletId, RULES[rule]] });

      // 4. kick off XRPL-address provisioning (best-effort; dashboard polls for it)
      fetch("/api/provision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletId }),
      }).catch(() => {});

      router.push(`/app/${walletId}`);
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <a href="/app" className="text-xs text-mist-500 hover:text-mist-300">← Your accounts</a>
      <h1 className="mt-3 text-2xl font-medium tracking-[-0.02em] text-mist-100">New account</h1>
      <p className="mt-1 text-sm text-mist-400">
        Name it, pick a policy, and Keyless makes the XRP account inside the enclave.
      </p>

      <div className="mt-8 space-y-6">
        <Card>
          <Field label="Account name" hint="How you'll tell your accounts apart — e.g. “Exchange savings”, “Trading bot”.">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Exchange savings" />
          </Field>
        </Card>

        <div>
          <h2 className="text-sm font-medium text-mist-200">What should this account be allowed to do?</h2>
          <p className="mt-1 text-xs text-mist-500">
            Pick the question that matters to you. You&rsquo;ll fill in the answer next.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {POLICY_SLOTS.map((slot) => (
              <PolicyCard key={slot.question} slot={slot} selected={rule} onSelect={setRule} />
            ))}
          </div>

          <div className="mt-7 flex items-center gap-3">
            <span className="hairline h-px flex-1 border-t" />
            <span className="text-[11px] uppercase tracking-[0.18em] text-mist-500">Or start from a use case</span>
            <span className="hairline h-px flex-1 border-t" />
          </div>
          {/* FXRP isn't one axis of "may this key sign" — it's a whole journey with several steps, each
              constrained. Mixing it into the questions grid made the grid look arbitrary. */}
          <div className="mt-3">
            <PolicyCard slot={{ question: "Earn on your XRP, safely", rule: "fxrp" }} selected={rule} onSelect={setRule} />
          </div>
        </div>

        {gasHelp && (
          <Notice tone="warn">
            <p>
              Your control key needs a little <span className="font-medium">C2FLR</span> for gas before it can
              create an account. Get some free from the{" "}
              <a href={gasHelp} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2 hover:text-amber-100">
                Flare Coston2 faucet ↗
              </a>{" "}
              and send it to your control-key address, then hit “Create account” again.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="min-w-0 break-all font-mono text-[12px] text-mist-200">{address}</code>
              <Copy text={address} label="Copy" />
            </div>
          </Notice>
        )}

        {error && <Notice tone="error">{error}</Notice>}

        <div className="flex items-center gap-4">
          <Button onClick={create} disabled={!!busy || !label.trim()}>
            {busy ? "Working…" : "Create account →"}
          </Button>
          {busy && <Spinner label={busy} />}
        </div>
      </div>
    </div>
  );
}
