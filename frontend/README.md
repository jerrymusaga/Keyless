# Keyless — frontend

The wallet UI. Next.js + React + viem, no wagmi and no connect modal — **Keyless is the wallet**, so the
signer is an embedded control key held in the browser rather than an extension.

See the [root README](../README.md) for what Keyless is, the architecture, and the live Coston2 addresses.
Live app: **[keyless-testnet.vercel.app](https://keyless-testnet.vercel.app)**

```bash
npm install
npm run dev          # http://localhost:3000
```

## What's where

| Path | |
|---|---|
| `app/page.tsx` | Marketing landing |
| `app/see/` | The no-signup showcase — every "try it" is a gasless `eth_call` against the real deployed rule |
| `app/app/` | The wallet: account list, `/app/new`, and the account page |
| `app/api/` | Server routes for things the browser can't do — full-history log reads, XRPL RPC, FDC condition checks, the faucet |
| `components/app/RuleConfig.tsx` | Every policy's configuration UI |
| `lib/keyless.ts` | Addresses, ABIs, rule metadata, the payment-reference helper |
| `lib/embedded.ts` | The control key — 12-word phrase, import/export, backup state |

## Two things worth knowing before you edit

**The control key is not the XRP key.** The browser holds a control key that edits rules and requests
payments. The XRP key lives in the enclave and never leaves it. Losing the control key loses the ability to
*change* a policy, not the money.

**Read `node_modules/next/dist/docs/` before assuming an API.** This Next.js has breaking changes from what
you may know — see [`AGENTS.md`](AGENTS.md).

## Checks

```bash
npx tsc --noEmit     # types
npx eslint .         # read the output; don't compare problem counts
npx next build       # compiles ≠ renders — still open the page
```
