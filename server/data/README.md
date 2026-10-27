# Runtime data

Optional files the server reads at startup. None are vendored in this
repository, so a fresh clone runs without them — with the behaviour noted below.
Paths are relative to the working directory (`/app` in the image); the
`Containerfile` copies this directory to `/app/data`.

| File | Env var | Without it |
|------|---------|------------|
| `qwen3_tokenizer.json` | `TOKENIZER_PATH` | token counts fall back to 2 chars/token; `make tokenizer` downloads it |
| `selfhelp_guide.md` | `SELFHELP_GUIDE_PATH` | the self-help prompt has no reference text |
| `sso_act_index.json` | `SSO_ACT_INDEX_PATH` | no SSO deep links are built |

The tokenizer is the Qwen3-Embedding-0.6B vocabulary (Apache-2.0). The other
two are local data files; supply your own copy and restart.
