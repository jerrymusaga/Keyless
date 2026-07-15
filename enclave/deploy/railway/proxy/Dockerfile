# Railway build of flare-foundation/tee-proxy, self-contained (clones tee-proxy +
# tee-node), with a start.sh that renders config.toml from Railway env vars.
#
# Versions MUST match the extension-tee image's tee-node (v0.0.20): the proxy and
# node share the TeeInfoResponse type and its attestation encoding changed between
# versions — a skew makes the proxy panic on startup. Keep these two in lockstep.
#
# Deploy as its own Railway service (root dir enclave/deploy/railway/proxy).
# Expose the EXTERNAL port (6664) publicly — the FDC availability check hits it.
ARG TEE_PROXY_VERSION=v0.0.17
ARG TEE_NODE_VERSION=v0.0.20

FROM golang:1.25.1-alpine AS builder
RUN apk add --no-cache git
ARG TEE_PROXY_VERSION
ARG TEE_NODE_VERSION
WORKDIR /app
RUN git clone --depth 1 --branch ${TEE_PROXY_VERSION} https://github.com/flare-foundation/tee-proxy.git
RUN git clone --depth 1 --branch ${TEE_NODE_VERSION} https://github.com/flare-foundation/tee-node.git
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
