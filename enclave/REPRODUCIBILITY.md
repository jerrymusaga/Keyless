# Reproducible build

The enclave is one Go image, built from [`Dockerfile`](Dockerfile). Given the same commit it is
**bit-for-bit identical regardless of when or where it is built**.

That property is what makes the trust chain checkable. A machine can only join extension 65645 by
attesting to a registered code hash — but a hash only means something if you can rebuild the image
yourself and get the same bytes. Without reproducibility, "the registered hash is this source" is a claim.
With it, it's a command anyone can run.

## The levers

All of these are in the Dockerfile:

- **Base image pinned by digest**, not tag, so every build starts from the same bytes.
- **`SOURCE_DATE_EPOCH`** set to the commit timestamp and passed as a build arg, clamping file mtimes and
  normalizing embedded dates.
- **apt pointed at [snapshot.debian.org](https://snapshot.debian.org)** keyed on that same epoch, so the
  exact package set that existed at the commit instant is what gets installed. (Adapted from
  [reproducible-containers](https://github.com/reproducible-containers/repro-sources-list.sh/blob/master/alternative/Dockerfile.debian-13).)
- **`-trimpath -ldflags="-buildid= -s -w"` and `-buildvcs=false`**, stripping build-host paths, Go's
  non-deterministic build id, symbol tables and VCS metadata.
- **`CGO_ENABLED=0`**, so the binary is static and link-time libc variance can't leak in.
- **A distroless final stage**, so nothing outside the explicit `COPY` lines reaches the image.
- **mtime normalization** (`find -exec touch`) before the copy, plus BuildKit's
  [`rewrite-timestamp`](https://github.com/moby/buildkit/pull/4057) exporter option.

`tee-node` is fetched from the network during `go mod download` and verified against `go/go.sum` — there
is no `replace` directive and no on-disk sibling repo, so `go/` is the entire build context.

## Verifying it

The default Docker builder doesn't properly support `rewrite-timestamp`
([moby/buildkit#4230](https://github.com/moby/buildkit/issues/4230)), so you need a `docker-container`
builder. One-time setup:

```sh
docker buildx create --driver=docker-container --name=moby-buildkit \
  --driver-opt image=moby/buildkit --bootstrap
```

Then from `enclave/`, build the commit you want to check and compare image ids:

```sh
docker buildx build --builder moby-buildkit --platform linux/amd64 --no-cache \
  --build-arg SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) \
  --output "type=docker,rewrite-timestamp=true" \
  -t keyless-enclave:verify --load -f Dockerfile .

docker inspect --format='{{.Id}}' keyless-enclave:verify
```

Two builds of the same commit, on any two machines, should print the same id.

## What this does and doesn't prove

It proves **source → image**: that the image someone is running is the code in this repo.

It does **not** currently prove **image → machine**. The enclave runs in Flare's simulated TEE mode
(`MODE=1`), where the code hash is fixed by configuration rather than attested by hardware. Reproducibility
is the half of the argument we can make today; hardware attestation (`MODE=0`, real Confidential Space) is
the other half, and it's roadmap item 2 in the [root README](../README.md).

## Two known nits

Both live in the Dockerfile, and both are cosmetic — the build itself is correct:

- The header comment says `tee-node v0.0.20`; `go/go.mod` pins `v0.0.21`. **`go.sum` is the authority**,
  and it's what `go mod verify` checks.
- The comment describes the build context as the upstream `extensions/sign/` directory. Here it is
  `enclave/`.

They are left alone on purpose. `railway.json` watches `/Dockerfile`, so editing this file — even a
comment — redeploys the enclave, and a restart in simulation mode regenerates its identity and strands
every existing account's funds. These get fixed in the same pass as the destination-tag finding in
[`SECURITY_NOTES.md`](../SECURITY_NOTES.md), once threshold key backup makes a restart survivable.
