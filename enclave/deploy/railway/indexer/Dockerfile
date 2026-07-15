# Railway build of flare-system-c-chain-indexer, self-contained (clones the repo)
# with a start.sh that renders config.toml from Railway env vars at boot.
#
# Deploy this as its own Railway service (root dir enclave/deploy/railway/indexer).
ARG INDEXER_VERSION=main

FROM golang:1.25-trixie AS builder
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
ARG INDEXER_VERSION
WORKDIR /build
RUN git clone --depth 1 --branch ${INDEXER_VERSION} \
      https://github.com/flare-foundation/flare-system-c-chain-indexer.git .
RUN go build -o /app/flare-cchain-indexer ./cmd/indexer

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /app/flare-cchain-indexer .
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
CMD ["/app/start.sh"]
