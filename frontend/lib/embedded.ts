"use client";

import { generateMnemonic, english, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";
import type { PrivateKeyAccount } from "viem";

/**
 * The embedded Keyless wallet — the account's *control key*, held in the browser, never by the
 * operator. This is NOT the key that holds the XRP (that one is born in the enclave and never leaves).
 * This key only signs the Flare-side transactions that configure your account: create it, point it at a
 * rule, edit that rule. Whoever holds it can change the rules, but the rules are all it can do — it
 * cannot make the enclave sign anything outside them.
 *
 * New wallets are generated as a 12-word recovery phrase rather than raw hex. A tester put it plainly:
 * 64 hex characters are "difficult to write down — get this wrong & your assets are gone". The phrase is
 * the same secret in a form a person can actually transcribe without a typo, and it derives the identical
 * account, so nothing downstream changes. Keys created before this still load and export as hex.
 *
 * On testnet we persist it in localStorage so a refresh keeps you signed in. The mainnet path is a
 * passkey-secured / smart-account upgrade — see the export + note in the UI.
 */
const PK_KEY = "keyless.embedded.pk.v1";
const MNEMONIC_KEY = "keyless.embedded.mnemonic.v1";
const BACKUP_KEY = "keyless.embedded.backedup.v1";

export type StoredWallet = {
  privateKey: `0x${string}`;
  /** The recovery phrase, when this wallet was created as one. Older wallets have only the hex key. */
  mnemonic: string | null;
  account: PrivateKeyAccount;
};

/** Derive the private key a phrase corresponds to — verified identical to `mnemonicToAccount`'s own. */
function keyFromMnemonic(mnemonic: string): `0x${string}` {
  const hd = mnemonicToAccount(mnemonic.trim().replace(/\s+/g, " "));
  return toHex(hd.getHdKey().privateKey!);
}

function load(): StoredWallet | null {
  if (typeof window === "undefined") return null;
  const pk = window.localStorage.getItem(PK_KEY) as `0x${string}` | null;
  if (!pk) return null;
  try {
    return { privateKey: pk, mnemonic: window.localStorage.getItem(MNEMONIC_KEY), account: privateKeyToAccount(pk) };
  } catch {
    return null;
  }
}

function persist(pk: `0x${string}`, mnemonic: string | null) {
  window.localStorage.setItem(PK_KEY, pk);
  if (mnemonic) window.localStorage.setItem(MNEMONIC_KEY, mnemonic);
  else window.localStorage.removeItem(MNEMONIC_KEY);
}

/** Return the existing embedded wallet, or create + persist a fresh one. Client-only. */
export function getOrCreateWallet(): StoredWallet {
  const existing = load();
  if (existing) return existing;
  const mnemonic = generateMnemonic(english);
  const pk = keyFromMnemonic(mnemonic);
  persist(pk, mnemonic);
  // A brand-new secret has, by definition, not been written down yet.
  window.localStorage.removeItem(BACKUP_KEY);
  return { privateKey: pk, mnemonic, account: privateKeyToAccount(pk) };
}

/** Read the embedded wallet without creating one. */
export function peekWallet(): StoredWallet | null {
  return load();
}

/**
 * Replace the browser's wallet with an imported secret — a recovery phrase or a raw private key.
 *
 * Accepting both matters: everything issued before the phrase existed is hex, and a person restoring on a
 * new device should not have to know which era their backup came from.
 */
export function importWallet(secret: string): StoredWallet {
  const trimmed = secret.trim().replace(/\s+/g, " ");
  if (trimmed.includes(" ")) {
    const pk = keyFromMnemonic(trimmed); // throws on an invalid phrase
    persist(pk, trimmed);
    window.localStorage.setItem(BACKUP_KEY, "1"); // they clearly already have it written down
    return { privateKey: pk, mnemonic: trimmed, account: privateKeyToAccount(pk) };
  }
  const pk = (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as `0x${string}`;
  const account = privateKeyToAccount(pk); // throws if malformed
  persist(pk, null);
  window.localStorage.setItem(BACKUP_KEY, "1");
  return { privateKey: pk, mnemonic: null, account };
}

/** Whether the user has confirmed they've saved the secret. */
export function isBackedUp(): boolean {
  if (typeof window === "undefined") return true; // never flash the warning during SSR
  return window.localStorage.getItem(BACKUP_KEY) === "1";
}

export function markBackedUp() {
  window.localStorage.setItem(BACKUP_KEY, "1");
}

/** Forget the embedded wallet on this device. The secret is gone unless it was written down. */
export function clearWallet() {
  window.localStorage.removeItem(PK_KEY);
  window.localStorage.removeItem(MNEMONIC_KEY);
  window.localStorage.removeItem(BACKUP_KEY);
}
