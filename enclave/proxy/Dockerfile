# Self-contained build of tee-proxy. Clones both tee-proxy and tee-node
# (its dependency) from GitHub so no local sibling repos are needed.
#
# Defaults are pinned to match the extension's Go-module pins (go/go.sum and
# go/tools/go.sum): tee-node v0.0.20 + tee-proxy v0.0.17. They MUST stay aligned
# with the extension-tee image's tee-node version — the proxy and the node share
# the TeeInfoResponse type, and its `attestation` encoding changed between
# versions (hexutil.Bytes <-> string). A skew here makes the proxy panic on
# startup with "cannot unmarshal hex string without 0x prefix ... TeeInfoResponse
# .attestation". Override via build args when bumping both sides together.

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

# Final stage
FROM alpine:latest

WORKDIR /app

COPY --from=builder /app/tee-proxy/main .
COPY --from=builder /app/tee-proxy/config.example.toml ./config/config.toml

RUN addgroup -g 1001 -S appgroup && \
    adduser -u 1001 -S appuser -G appgroup

RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 6661
EXPOSE 6662

CMD ["./main"]
