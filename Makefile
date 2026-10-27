# Everything runs in podman; nothing needs to be installed on the host.
RUST  = docker.io/library/rust:1-bookworm
NODE  = docker.io/library/node:22-bookworm-slim
PODRUN = podman run --rm -v "$(CURDIR)":/w
# Static musl build (matches the scratch runtime image; see Containerfile).
MUSL_TARGET = x86_64-unknown-linux-musl
RUST_MUSL = $(PODRUN) -w /w/server -v lbl-cargo:/usr/local/cargo/registry -e CARGO_TARGET_DIR=/w/server/target $(RUST) sh -c 'apt-get update -qq && apt-get install -y -qq musl-tools && rustup target add $(MUSL_TARGET) && '

.PHONY: server-test server-miri server-load server-load-byok server-real server-build server-build-static web-build web-test evals test image up tokenizer
# Qwen3 tokenizer for exact token counts (Apache-2.0, ~11 MB, not vendored — see README).
tokenizer:
	curl -fsSL -o server/data/qwen3_tokenizer.json https://huggingface.co/Qwen/Qwen3-Embedding-0.6B/resolve/main/tokenizer.json
# Debug build (target/debug) — used by the eval suite.
server-build:
	$(PODRUN) -w /w/server -v lbl-cargo:/usr/local/cargo/registry -e CARGO_TARGET_DIR=/w/server/target $(RUST) cargo build
# Static release build (target/$(MUSL_TARGET)/release) — same as the image.
server-build-static:
	$(RUST_MUSL) RUSTFLAGS="-C target-feature=+crt-static" cargo build --release --target $(MUSL_TARGET)
server-test:
	$(RUST_MUSL) cargo test
# Memory-safety / cancellation tests under Miri (nightly). The app has no `unsafe`, so
# this is about Drop: Permit slots, aborted tasks, dropped streams. Runs only the
# socket-free tests (the rest need real IO, which Miri cannot do). Toolchain and
# build output live in named volumes so reruns are incremental.
# isolation is disabled only because `admit()` reads the wall clock (chrono::Utc::now).
server-miri:
	$(PODRUN) -w /w/server -v lbl-rustup:/usr/local/rustup -v lbl-cargo:/usr/local/cargo/registry -v lbl-miri-target:/miri-target -e CARGO_TARGET_DIR=/miri-target -e MIRIFLAGS="-Zmiri-disable-isolation" $(RUST) sh -c 'rustup toolchain install nightly --profile minimal -c miri -c rust-src && cargo +nightly miri test --lib -- limits:: drop_tests::'
# 300 concurrent users against the real static musl binary (the one the scratch image ships)
# + mock upstream (evals/load.mjs). USERS / WAVES override the defaults. Writes evals/load-results.json.
server-load: server-build-static
	podman run --rm --network host -v "$(CURDIR)":/w -w /w/evals -e USERS -e WAVES -e SERVER_BIN=/w/server/target/$(MUSL_TARGET)/release/lawbylaw-server $(NODE) node load.mjs
# The browser-direct path (/api/agent, /api/tool, /api/cite, /api/links) under 300 honest users,
# hammering clients, malformed requests and 30000 rotating IPs (evals/load-byok.mjs). Honest users
# run the browser's real client, retries included. Any LIMIT_* variable is passed to the server.
server-load-byok: server-build-static
	podman run --rm --network host -v "$(CURDIR)":/w -w /w/evals -e USERS -e WAVES -e PHASES -e ROTATE_IPS $(foreach v,$(filter LIMIT_%,$(.VARIABLES)),-e $(v)) -e SERVER_BIN=/w/server/target/$(MUSL_TARGET)/release/lawbylaw-server $(NODE) node load-byok.mjs
# The tools against the real embedder, reranker and Qdrant from .env (no mock, no LLM key needed):
# correctness, odd input, latency, and a few dozen concurrent turns (STEPS="5,15,30").
# Qdrant is reached as localhost because this runs on the host network, not inside compose.
server-real: server-build-static
	podman run --rm --network host -v "$(CURDIR)":/w -w /w/evals --env-file .env -e QDRANT_HOST=127.0.0.1 -e STEPS -e SEQ -e SERVER_BIN=/w/server/target/$(MUSL_TARGET)/release/lawbylaw-server $(NODE) node real-backend.mjs
web-build:
	$(PODRUN) -w /w/web $(NODE) npx vite build
web-test:
	$(PODRUN) -w /w/web $(NODE) npx vitest run
# Needs server-build + web-build first. Writes evals/report.md
evals: server-build web-build
	podman run --rm --network host -v "$(CURDIR)":/w -w /w/evals $(NODE) npm run eval
test: server-test web-test evals
image:
	podman build -t lawbylaw -f Containerfile .
up:
	podman compose up --build
