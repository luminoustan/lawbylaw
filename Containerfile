# Single image: Rust API + built web UI served from /app/static.
#
# The runtime stage is `scratch` (empty): the server is a fully static musl
# binary, so the image contains no libc, no shell and no OS packages. This keeps
# the SBOM free of copyleft (glibc is LGPL, Debian ships GPL utilities). See
# SBOM-AUDIT.md. The trade-off is no shell in the image (debug via `podman logs`).
FROM docker.io/library/node:22-bookworm-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm ci || npm install
COPY web/ ./
RUN npx vite build

FROM docker.io/library/rust:1-bookworm AS server
# musl-tools provides the static C toolchain; the musl target is added via rustup.
RUN apt-get update \
 && apt-get install -y --no-install-recommends musl-tools \
 && rm -rf /var/lib/apt/lists/* \
 && rustup target add x86_64-unknown-linux-musl
WORKDIR /s
COPY server/ ./
# +crt-static links libc statically so the binary runs on scratch.
RUN RUSTFLAGS="-C target-feature=+crt-static" \
    cargo build --release --target x86_64-unknown-linux-musl

FROM scratch
# CA roots for outbound HTTPS (DeepSeek). scratch has none, so copy them in.
COPY --from=server /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=server /s/target/x86_64-unknown-linux-musl/release/lawbylaw-server /app/lawbylaw-server
COPY --from=server /s/data /app/data
COPY --from=web /web/dist /app/static
# cwd for the relative TOKENIZER_PATH default (data/qwen3_tokenizer.json).
WORKDIR /app
ENV STATIC_DIR=/app/static PORT=8000 TRUST_PROXY=none
EXPOSE 8000
ENTRYPOINT ["/app/lawbylaw-server"]
