"use client";

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { PrivateKeyAccount } from "viem";

/**
 * The embedded Keyless wallet — the account's *control key*, held in the browser, never by the
 * operator. This is NOT the key that holds the XRP (that one is born in the enclave and never leaves).
 * This key only signs the Flare-side transactions that configure your account: create it, point it at a
 * rule, edit that rule. Whoever holds it can change the rules, but the rules are all it can do — it
 * cannot make the enclave sign anything outside them.
 *
 * On testnet we persist it in localStorage so a refresh keeps you signed in. It is exportable, and the
 * mainnet path is a passkey-secured / smart-account upgrade — see the export + note in the UI.
 */
const STORAGE_KEY = "keyless.embedded.pk.v1";

export type StoredWallet = { privateKey: `0x${string}`; account: PrivateKeyAccount };

function load(): StoredWallet | null {
  if (typeof window === "undefined") return null;
  const pk = window.localStorage.getItem(STORAGE_KEY) as `0x${string}` | null;
  if (!pk) return null;
  try {
    return { privateKey: pk, account: privateKeyToAccount(pk) };
  } catch {
    return null;
  }
}

/** Return the existing embedded wallet, or create + persist a fresh one. Client-only. */
export function getOrCreateWallet(): StoredWallet {
  const existing = load();
  if (existing) return existing;
  const pk = generatePrivateKey();
  window.localStorage.setItem(STORAGE_KEY, pk);
  return { privateKey: pk, account: privateKeyToAccount(pk) };
}

/** Read the embedded wallet without creating one. */
export function peekWallet(): StoredWallet | null {
  return load();
}

/** Replace the browser's embedded wallet with an imported private key (restore / move device). */
export function importWallet(pk: `0x${string}`): StoredWallet {
  const account = privateKeyToAccount(pk); // throws if malformed
  window.localStorage.setItem(STORAGE_KEY, pk);
  return { privateKey: pk, account };
}

/** Forget the embedded wallet on this device. The key is gone unless it was exported. */
export function clearWallet() {
  window.localStorage.removeItem(STORAGE_KEY);
}
