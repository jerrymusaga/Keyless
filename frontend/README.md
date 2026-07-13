# Keyless frontend

Minimal Vite + React skeleton for the demo UI. Structured around the demo beat
(check binding → pay allowlisted → watch a non-allowlisted payment revert).

```bash
npm install
npm run dev
```

Fill `src/config.js` with the deployed policy address first. This is a starting point —
wallet connection and the write/revert flow are the next build steps (see comments in App.jsx).
