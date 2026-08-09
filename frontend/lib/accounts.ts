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

export function listAccounts(owner: string): LocalAccount[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(keyFor(owner)) ?? "[]");
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
