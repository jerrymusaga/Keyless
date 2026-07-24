# Railway build of flare-foundation/tee-proxy, self-contained (clones tee-proxy),
# with a start.sh that renders config.toml from Railway env vars.
#
# TEE_PROXY_VERSION MUST match the extension-tee image's Go-module pins (tee-proxy
# v0.0.18). tee-proxy's own go.mod transitively pins the matching tee-node +
# go-flare-common line, so `go mod download` pulls the exact governance-aware node
# code the extension-tee uses — no separate tee-node clone needed. A version skew
# makes the proxy panic on startup (the TeeInfoResponse encoding differs).
#
# Deploy as its own Railway service (root dir enclave/deploy/railway/proxy).
# Expose the EXTERNAL port (6664) publicly — the FDC availability check hits it.
ARG TEE_PROXY_VERSION=v0.0.18

FROM golang:1.25.1-alpine AS builder
RUN apk add --no-cache git
ARG TEE_PROXY_VERSION
WORKDIR /app
RUN git clone --depth 1 --branch ${TEE_PROXY_VERSION} https://github.com/flare-foundation/tee-proxy.git
WORKDIR /app/tee-proxy
RUN go mod download
RUN CGO_ENABLED=0 GOOS=linux go build -a -o main ./cmd/proxy

FROM alpine:latest
RUN apk add --no-cache ca-certificates
WORKDIR /app
COPY --from=builder /app/tee-proxy/main .
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh
EXPOSE 6663
EXPOSE 6664
CMD ["/app/start.sh"]
