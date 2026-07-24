# Keyless address relayer — a tiny always-on service that reads the enclave's /state
# over Railway's private network and records wallet XRPL addresses on-chain.
#
# Deploy as its own Railway service (root dir enclave/deploy/railway/relayer). No public
# domain needed — it only makes outbound calls (enclave /state + Coston2 RPC).
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY relayer.mjs ./
CMD ["node", "relayer.mjs"]
