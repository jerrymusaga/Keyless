"use client";

/**
 * A client-side registry of the accounts this embedded wallet has created. The embedded wallet is
 * browser-local, so the natural place to remember "which walletIds are mine" is here too. walletId is
 * derived deterministically on-chain (walletIdFor(owner, salt)); this keeps the human label and salt
 * alongside it so the common case needs no log scan.
 *
 * This is a CACHE, not the source of truth. `WalletCreated` indexes `owner`, so the account list is
 * always derivable from the control key alone — /api/accounts-of does exactly that, and the accounts page
 * folds anything missing back in. A key imported into a new browser finds its accounts; only the labels
 * and salts are local, and neither is needed to use an account.
 */
export type LocalAccount = {
  walletId: `0x${string}`;
  label: string;
  salt: `0x${string}`;
  createdAt: number;
};

function keyFor(owner: string) {
  return `keyless.accounts.${owner.toLowerCase()}`;
}

/**
 * An earlier recovery wrote "Recovered account N" as a real label, so that placeholder is persisted for
 * anyone who recovered before it was replaced. Strip it on read — a recovered account has no label, and
 * the UI describes it by its policy and address instead, which is recognisable in a way a number isn't.
 */
const PLACEHOLDER = /^Recovered account \d+$/;

export function listAccounts(owner: string): LocalAccount[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = JSON.parse(window.localStorage.getItem(keyFor(owner)) ?? "[]") as LocalAccount[];
    const healed = raw.map((a) => (PLACEHOLDER.test(a.label ?? "") ? { ...a, label: "" } : a));
    // Write back once so it's genuinely gone, not re-hidden on every read.
    if (healed.some((a, i) => a.label !== raw[i].label)) {
      window.localStorage.setItem(keyFor(owner), JSON.stringify(healed));
    }
    return healed;
  } catch {
    return [];
  }
}

export function addAccount(owner: string, acct: LocalAccount) {
  const all = listAccounts(owner);
  if (all.some((a) => a.walletId === acct.walletId)) return;
  all.unshift(acct);
  window.localStorage.setItem(keyFor(owner), JSON.stringify(all));
}

export function getAccount(owner: string, walletId: string): LocalAccount | undefined {
  return listAccounts(owner).find((a) => a.walletId.toLowerCase() === walletId.toLowerCase());
}
