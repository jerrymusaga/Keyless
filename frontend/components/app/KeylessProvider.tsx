"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Abi, PrivateKeyAccount } from "viem";
import { getOrCreateWallet, peekWallet, clearWallet, importWallet, isBackedUp, markBackedUp } from "@/lib/embedded";
import { publicClient, walletClientFor } from "@/lib/clients";

/**
 * The one place the app touches the embedded wallet. It owns the control key's lifecycle (create /
 * load / forget), keeps its C2FLR balance fresh, tops it up through the gas sponsor, and is the single
 * path for every on-chain write. Pages read chain state through the shared public client directly.
 */
type WriteArgs = {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
};

type Ctx = {
  status: "loading" | "none" | "ready";
  account: PrivateKeyAccount | null;
  address: `0x${string}` | null;
  balance: bigint;
  create: () => void;
  forget: () => void;
  /** Reveal the control key's private key for backup. XRP keys are never exportable — this is only
   *  the browser-held control key. Returns null if there's no wallet. */
  /** The secret to write down: a recovery phrase where there is one, otherwise the raw key. */
  exportSecret: () => { secret: string; isPhrase: boolean } | null;
  exportKey: () => `0x${string}` | null;
  backedUp: boolean;
  confirmBackedUp: () => void;
  /** Replace this device's control key with an imported one (restore / move device). */
  importKey: (secret: string) => void;
  refreshBalance: () => Promise<void>;
  /** Ensure the control key has gas. Returns whether the sponsor is configured. */
  ensureFunded: () => Promise<{ ok: boolean; disabled: boolean; faucet?: string }>;
  /** Sign + send a transaction from the control key and wait for its receipt. */
  write: (args: WriteArgs) => Promise<`0x${string}`>;
};

const KeylessContext = createContext<Ctx | null>(null);

export function KeylessProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<PrivateKeyAccount | null>(null);
  const [status, setStatus] = useState<Ctx["status"]>("loading");
  // Whether the secret has been written down. Tracked here so the app can insist on it before an account
  // exists — a tester lost nothing but reasonably assumed they had, because nothing ever asked.
  const [backedUp, setBackedUp] = useState(true);
  const [balance, setBalance] = useState<bigint>(0n);

  useEffect(() => {
    const w = peekWallet();
    if (w) {
      setAccount(w.account);
      setBackedUp(isBackedUp());
      setStatus("ready");
    } else {
      setStatus("none");
    }
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!account) return;
    setBalance(await publicClient.getBalance({ address: account.address }));
  }, [account]);

  useEffect(() => {
    if (!account) return;
    refreshBalance();
    const t = setInterval(refreshBalance, 12_000);
    return () => clearInterval(t);
  }, [account, refreshBalance]);

  const create = useCallback(() => {
    const w = getOrCreateWallet();
    setAccount(w.account);
    setBackedUp(isBackedUp()); // a freshly generated secret reads as not-yet-written-down
    setStatus("ready");
  }, []);

  const forget = useCallback(() => {
    clearWallet();
    setAccount(null);
    setBalance(0n);
    setStatus("none");
  }, []);

  const exportKey = useCallback(() => peekWallet()?.privateKey ?? null, []);
  const exportSecret = useCallback(() => {
    const w = peekWallet();
    if (!w) return null;
    return w.mnemonic ? { secret: w.mnemonic, isPhrase: true } : { secret: w.privateKey, isPhrase: false };
  }, []);

  const importKey = useCallback((secret: string) => {
    const w = importWallet(secret); // throws on a malformed phrase or key
    setAccount(w.account);
    setBackedUp(true); // importing means they already hold it somewhere
    setStatus("ready");
  }, []);

  const confirmBackedUp = useCallback(() => { markBackedUp(); setBackedUp(true); }, []);

  const ensureFunded = useCallback(async () => {
    if (!account) return { ok: false, disabled: false };
    const res = await fetch("/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: account.address }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 501) return { ok: false, disabled: true, faucet: body.faucet };
    await refreshBalance();
    return { ok: !!body.ok, disabled: false };
  }, [account, refreshBalance]);

  const write = useCallback(
    async (args: WriteArgs) => {
      if (!account) throw new Error("no embedded wallet");
      const wallet = walletClientFor(account);
      const hash = await wallet.writeContract({
        address: args.address,
        abi: args.abi,
        functionName: args.functionName,
        args: args.args as never,
        value: args.value,
      });
      await publicClient.waitForTransactionReceipt({ hash });
      await refreshBalance();
      return hash;
    },
    [account, refreshBalance],
  );

  return (
    <KeylessContext.Provider
      value={{
        status,
        account,
        address: account?.address ?? null,
        balance,
        create,
        forget,
        exportKey,
        exportSecret,
        backedUp,
        confirmBackedUp,
        importKey,
        refreshBalance,
        ensureFunded,
        write,
      }}
    >
      {children}
    </KeylessContext.Provider>
  );
}

export function useKeyless() {
  const ctx = useContext(KeylessContext);
  if (!ctx) throw new Error("useKeyless must be used within KeylessProvider");
  return ctx;
}
