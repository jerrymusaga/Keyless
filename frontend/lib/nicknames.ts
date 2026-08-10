"use client";

/**
 * Human names for XRPL addresses, per control key.
 *
 * A tester asked for this directly: setting several addresses across policies "without recognisable names
 * make it very confusing which wallet you're sending XRP to". An r-address is 34 characters of base58 and
 * two of them differ in the middle; nobody should be asked to check that by eye before approving a payee.
 *
 * These live in localStorage, which we've just been burned by — so, deliberately: a nickname is the only
 * kind of thing that can safely live there. Losing it costs you a label, not an account. The address is
 * always shown alongside and remains the thing the rule actually enforces, so a fresh browser degrades to
 * exactly what the app showed before nicknames existed. Contrast the account list, which had to move
 * on-chain (see /api/accounts-of) because losing THAT looked like losing money.
 */
const KEY = (owner: string) => `keyless.nicknames.${owner.toLowerCase()}`;

type Book = Record<string, string>; // lowercased address -> name

function read(owner: string): Book {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(KEY(owner)) ?? "{}") as Book;
  } catch {
    return {};
  }
}

export function nicknameOf(owner: string | null | undefined, address: string): string | null {
  if (!owner || !address) return null;
  return read(owner)[address.toLowerCase()] ?? null;
}

export function setNickname(owner: string, address: string, name: string) {
  const book = read(owner);
  const clean = name.trim().slice(0, 40); // a label, not an essay
  if (clean) book[address.toLowerCase()] = clean;
  else delete book[address.toLowerCase()];
  window.localStorage.setItem(KEY(owner), JSON.stringify(book));
  window.dispatchEvent(new Event("kl:nicknames-changed"));
}
