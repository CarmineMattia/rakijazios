# Model advisor: "what can my computer run?" (proposal)

> **Status:** 🔮 proposal, docs only. Nothing here is built yet.
> **Touches:** the runner, the pairing / **My hardware** flow, bot settings.
> **Comes after:** Share local AI M2 ([`share-local-ai.md`](share-local-ai.md)), before the M5 device app.
> **Research date:** 2026-10-13. Every model name, size, license and API fact below comes from a
> live call made that day (unauthenticated, no HF token), except the local Ollama version (0.32.5),
> which was read once on Host-001.
> **Units:** sizes from the Hub are **GB** (decimal, like disks) and the UI shows GB. Memory budgets
> and fit math are **GiB** internally (1 GiB = 1.074 GB).
> **Review:** updated after the Rakazo Tester review of `3a0e09c` (fit budget per platform, pinned
> revisions, on-device install confirmation, security and UX requirements). Re-run the queries in [§11](#11-how-to-re-check-the-facts),
> because the Hub changes daily.

## TL;DR

- 🔍 The runner **detects the hardware** (CPU, RAM, GPU/VRAM, unified memory) and, **only if the owner
  opts in**, sends a **coarse** summary (buckets, no serials or hostnames) over the existing runner socket.
- 📚 The server keeps a **cached catalog from the Hugging Face Hub**, filtered through a **curated
  allowlist**. Raw trending is not usable as-is (see [§3.1](#31-why-raw-trending-is-not-enough)).
- 🧮 Each model/quant gets a **fit tier**: ✅ fits comfortably / 🟡 tight / ⛔ won't fit. The tier comes
  from the real GGUF file size, the KV cache for the chosen context, and overhead.
- ⭐ A **best pick per use case**: 💬 chat, 👩‍💻 coding, 👁️ vision, ⚡ small and fast.
- ⬇️ **One-click install** into the local runtime (Ollama or llama.cpp), GGUF only, with a **SHA-256
  check** and a **disk-space check**.
- 🧭 An optional **planner/router model** (e.g. Liquid **LFM2.5**) decides and the big model executes.
  Never a silent fallback.

---

## 1. Goals and non-goals

**Goals**
- Answer "what can this computer run, and what's the best choice?" in one glance on **My hardware**.
- Keep the list fresh automatically (new models appear on HF every day) while staying safe.
- Make installing a recommended model a single, verified, reversible action.
- Let a bot use a small **decision model** plus a big **execution model**.

**Non-goals (for now)**
- Benchmarking quality ourselves. We rank with curated metadata plus Hub signals, not our own evals.
- Running non-GGUF formats (safetensors with custom code, pickles, ONNX) on the user's machine.
- Choosing models for cloud providers. This is about **local** hardware.

---

## 2. Runner-side hardware detection

The runner already sends `platform` (e.g. `linux-x64`) and `modelServer` (e.g. `ollama`) in its `hello`
frame (M2a, `runner/src/protocol.ts`). Detection extends that.

### 2.1 What to detect, per OS

| What | 🐧 Linux | 🍎 macOS | 🪟 Windows |
|---|---|---|---|
| OS, arch | `/etc/os-release`, `uname -m` | `sw_vers`, `uname -m` | `os.release()`, `process.arch` |
| CPU model, cores/threads, SIMD | `/proc/cpuinfo` / `lscpu` (`avx2`, `avx512f`, `amx`) | `sysctl machdep.cpu` / `hw.optional.arm.*` | WMI `Win32_Processor` |
| RAM total | `/proc/meminfo` | `sysctl hw.memsize` | `GlobalMemoryStatusEx` (Node `os.totalmem()`) |
| NVIDIA | `nvidia-smi --query-gpu=name,memory.total --format=csv` | n/a | `nvidia-smi` (ships with the driver) |
| AMD discrete / APU | `/sys/class/drm/card*/device/mem_info_vram_total` and `mem_info_gtt_total`; `rocm-smi --showmeminfo vram --json` if present | n/a | DXGI adapter info (dedicated + shared) |
| Intel Arc / iGPU | sysfs `i915` / `xe` (`/sys/class/drm/card*/device`), Level Zero / `xpu-smi` if present, else Vulkan/SYCL | n/a | DXGI adapter info; `xpu-smi` if present |
| Vulkan (any vendor) | `vulkaninfo --summary` | MoltenVK (rare) | `vulkaninfo --summary` |
| Apple Metal / unified | n/a | `system_profiler SPDisplaysDataType -json`; unified = RAM; Metal's `recommendedMaxWorkingSetSize` is the real GPU budget (Node can't read it: needs a tiny Swift/Metal helper or the runtime's report) | n/a |
| Free disk (models dir) | `statfs` on the Ollama / llama.cpp models dir | same | same |

**Best single source: ask the runtime.** The runtime is what will actually load the model, so its view
wins over our own probes:

| Runtime | How it exposes hardware (verified 2026-10-13) |
|---|---|
| **llama.cpp** | `llama-server --list-devices` prints each backend device with total/free MiB. Host-001, build 10240: `Vulkan0: AMD Radeon 8060S Graphics (RADV STRIX_HALO) (129453 MiB, 128597 MiB free)`. |
| **Ollama** | No hardware endpoint in the API docs, so it's only usable *after* a model is loaded. `GET /api/ps` gives `size` and `size_vram` per loaded model (how much really landed on the GPU). `POST /api/show` gives `model_info` (`*.block_count`, `*.attention.head_count_kv`, `*.context_length`, …), which we need for the KV-cache math. `GET /api/version` gives the version. |
| **LM Studio** | The REST API (`/api/v1/*`) has no hardware endpoint. The CLI has `lms runtime survey --json`, which returns GPU name, detection platform (CUDA/Metal/ROCm/Vulkan), integration type (discrete/integrated), VRAM, RAM and CPU. |

Rule: **runtime report > OS probe > nothing**. When sources disagree, report both and take the
**smaller** one for fit math (see [§10](#10-feasibility-check-on-host-001)).

### 2.2 Memory budget per platform

"VRAM" means different things per platform. The **usable budget** (the number fit tiers use, in GiB)
is computed per memory kind, and §3.4 and §10 both use these rules:

| Kind | Budget rule | `sharesSystemRam` |
|---|---|---|
| 🎮 **Discrete GPU** (NVIDIA / AMD / Intel Arc) | VRAM − 0.5 GiB. Optional CPU offload into (RAM − OS reserve) puts the model in 🟡 at best (slow). | `false` |
| 🧩 **Linux AMD APU with carve-out** (e.g. Strix Halo) | (BIOS VRAM carve-out + OS-visible RAM) − OS reserve, **capped** by the runtime-reported device memory and by the GTT / `ttm.pages_limit` cap. | `true` |
| 🍎 **Apple Silicon** | Metal `recommendedMaxWorkingSetSize` (already excludes what macOS keeps). No extra reserve. | `true` |
| 🪟 **Windows iGPU** (AMD / Intel) | DXGI dedicated + shared is only an **upper bound**. Every fit is 🟡 at best until measured on that device. | `true` |
| 🧮 **CPU only** | RAM − OS reserve, 🟡 at best for > 8B models. | `true` |

**OS reserve** (unified kinds): **max(16 GiB, 10 % of physical RAM)** on a desktop that also runs
other apps (browser, docker, the Rakijazios stack); max(8 GiB, 10 %) on a headless node. The owner
can change it.

**GTT is not extra memory.** On a Linux APU, the GTT pool *is* the OS's own RAM, mapped for the
GPU. Carve-out + GTT therefore equals what the runtime reports (Host-001: 65,536 + 63,917 =
129,453 MiB, exactly the llama.cpp figure). The physical total is still 128 GiB, and anything above
the carve-out comes **out of the OS's RAM**. Never add RAM and GPU memory together for the budget.

### 2.3 Privacy: coarse and opt-in

- **Prefer local fit computation (default design).** The server sends the candidate list (sizes,
  KV parameters), the runner computes the tiers **on the device** and returns only tiers. No
  hardware report has to leave the machine at all. The coarse report below is only sent if the
  owner also opts in to "show my hardware on the web".
- **Off by default.** The owner turns on "Help me pick models" on the device card. The runner only
  sends the report when the server's `policy` says so **and** the local config allows it.
- **Coarse buckets only**: RAM and GPU memory rounded to a bucket (8/16/24/32/48/64/96/128/192/256+ GiB),
  disk free as a class (< 50 / 50–200 / 200–1000 / > 1000 GB), CPU as cores/threads + SIMD class,
  GPU as **vendor + family** (e.g. "AMD RDNA 3.5 APU"), not the exact SKU. **No runtime versions**
  (they reveal the patch level). Exact GPU + CPU + versions + disk together can fingerprint a niche
  machine.
- **Never sent**: serial numbers, MAC addresses, hostname, username, file paths, the list of other
  installed software, exact free bytes.
- The owner can **see the exact JSON** that was sent ("What did my computer share?") and delete it.
- **Retention:** the server keeps only the latest report (overwritten, deleted with the device, or
  after 90 days offline) and never writes it to logs.
- Only the owner sees the report. Shared-group members never do (same rule as device names in M2a).

### 2.4 Protocol (additive, versioned)

New frames, all optional, so old runners and servers keep working:

```jsonc
// server → runner: inside the existing `policy` frame
{ "type": "policy", "hardwareReport": true, "installs": false, ... }

// runner → server: after `hello`, and again when something changes (at most once an hour)
{ "type": "hardware", "v": 1,
  "os": "linux", "arch": "x64",
  "cpu": { "cores": 16, "threads": 32, "simd": ["avx2", "avx512"] },
  "memory": { "totalPhysicalGiB": 128, "osVisibleGiB": 64 },   // buckets
  "accelerators": [
    { "vendor": "amd", "family": "RDNA 3.5 APU", "kind": "apu-carveout",
      "backend": "vulkan", "deviceMemGiB": 128, "sharesSystemRam": true,
      "source": "llama.cpp" } ],
  "budgetGiB": 110,                                  // computed on the device, §2.2
  "runtimes": [ "ollama", "llama.cpp" ],             // names only, no versions
  "diskFree": "200-1000" | ">1000" }
```

`sharesSystemRam: true` tells the server that `deviceMemGiB` and `osVisibleGiB` overlap and
must **not** be added. Install frames are in [§4](#4-one-click-download-and-install).

---

## 3. The recommender (server side)

### 3.1 Why raw trending is not enough

On 2026-10-13, `GET /api/models?filter=gguf&sort=trendingScore&limit=5` returned:
`jialinyyzz/humanizer`, `abenzerps/Qwen-Image-2.1-Uncensored-Quantized` (text-to-image),
`ConwayResearch/Underdog-Saluki-27B-1.0`, `AtomicChat/Qwen-Image-2.1-Turbo-Uncensored-GGUF`, and a merge
named `nerkyor/Qwen3.8-27B-Coder390-EfficientThink-Opus5.5-GPT6Astra-Grok4.7-DSV4Pro-K3-SFT-RLOO-MTP-DFlash2`.
Sorting by `likes` also surfaces "Uncensored" re-uploads. Trending is a **discovery signal**, never a
recommendation.

### 3.2 Verified Hugging Face Hub API facts

All calls were made unauthenticated on 2026-10-13.

> **Note:** example URLs here and in §11 use `main` for research. Production always uses the pinned
> 40-character commit `sha` (`tree/<sha>`, `resolve/<sha>/…`), never `main` (§3.3, §4).

| Need | Call | What it returns (verified) |
|---|---|---|
| List GGUF repos | `GET https://huggingface.co/api/models?filter=gguf&sort=<key>&limit=N` | `sort` worked with `trendingScore`, `downloads`, `likes`, `lastModified`, `createdAt`. Default keys: `_id, id, modelId, private, downloads, likes, pipeline_tag, library_name, tags, createdAt` (`library_name` absent with `sort=lastModified`), plus `trendingScore` / `lastModified` when sorted by them. |
| Filter by publisher | `&author=unsloth` / `&author=LiquidAI` | ✅ works |
| Filter by task | `&pipeline_tag=text-generation` (also `image-text-to-text`) | ✅ works |
| Filter by size | `&num_parameters=min:20B,max:40B` | ✅ returned only 26.9–31.2B models (`gguf.total`) |
| Filter by app | `&apps=llama.cpp`, `&apps=ollama` | ✅ validated (an unknown value returns an error listing 17 allowed apps: `llama.cpp`, `lmstudio`, `ollama`, `vllm`, `mlx-lm`, `jan`, …) and it filters: with `apps=llama.cpp` the text-to-image repo drops out of trending, and without `filter=gguf` it returns only GGUF repos. The semantics are undocumented, so it's used **as a pre-filter only, never trusted for compatibility**. |
| Extra fields | `&expand[]=cardData&expand[]=gguf&expand[]=safetensors&expand[]=lastModified&expand[]=baseModels` | `cardData.license` / `license_name`, `gguf.{total, totalFileSize, architecture, context_length, chat_template}` (`gguf.total` is the **parameter count**, not bytes), `safetensors.total` (params), `baseModels` (e.g. `relation: "quantized"` → `Qwen/Qwen3.8-27B`) |
| Pinned revision | `GET /api/models/<repo>?expand[]=sha` | `sha`: the 40-hex commit (e.g. `b17cb02dd882d5b6ab62fc777ad2995f19668350` for `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF`) |
| Files and sizes | `GET /api/models/<repo>/tree/<sha>?recursive=true` (the research used `main`; the catalog uses the pinned `sha`) | each file: `path`, `size`, `lfs.oid` (**SHA-256**), so split shards in subfolders are visible too |
| Architecture details (layers, KV heads) | HTTP `Range: bytes=0-8388607` on `/<repo>/resolve/main/<file>.gguf` | `206`, enough to parse the GGUF header. `Qwen3-Coder-30B-A3B UD-Q4_K_XL`: `block_count=48, head_count_kv=4, key_length=128, value_length=128, expert_count=128, context_length=262144` |
| Integrity | `HEAD /<repo>/resolve/main/<file>` | `302` to the CDN; `x-linked-size` and `x-linked-etag` = the same SHA-256 as `lfs.oid` (checked on `LFM2.5-1.2B-Instruct-Q4_K_M.gguf`: `b1b3de11…b4f5`, 730,895,168 bytes) |
| Rate limits | response headers | `ratelimit-policy: "fixed window";"api";q=500;w=300` (API) and `"resolvers";q=3000;w=300` (downloads) for anonymous calls. [HF docs](https://huggingface.co/docs/hub/rate-limits) (Sept '25 table): anonymous 500 / 3,000, free user with token 1,000 / 5,000, PRO 2,500 / 12,000 per 5 min. Exceeding the limit returns `429` plus a `RateLimit` header with the reset seconds. |

**Implications**
- A full catalog refresh (≈ 30 allowlisted families × list + tree + expand ≈ 100 calls) fits easily
  in the anonymous API budget. Refresh **every 6–12 h** on the server, never per page view.
- Downloads happen on the **user's** machine, from their IP, against the resolver bucket (3,000 per 5 min),
  so one install is a handful of requests.
- An **HF token is optional** for the server (an operator setting, stored like other secrets, never
  logged, never sent to runners). It's needed only for gated repos, which we skip in v1 anyway.

### 3.3 Catalog pipeline

1. **Allowlist of families and publishers** in the repo (`advisor/allowlist.json`, reviewed by PR):
   e.g. upstream orgs (`Qwen`, `LiquidAI`, `ibm-granite`, `microsoft`, `google`, `mistralai`, `openai`,
   `meta-llama`, `nvidia`) plus well-known GGUF packagers (`unsloth`, `ggml-org`, `bartowski`, …).
   Each entry has: family, use cases, an "upstream base" check, the license expected, and a hand-set
   **quality tier** (A/B/C).
2. **Pin**: for every candidate repo, read its `sha` (40-hex commit) and from then on use only
   `tree/<sha>` and `resolve/<sha>/…`. The catalog stores `repo + sha + path + size + sha256 +
   chat_template_sha256 + license` per file. **Branch names (`main`) are never stored or sent.**
   A newer upstream `sha` becomes a new catalog entry that is re-reviewed (Q8).
3. **Fetch**: per allowlisted author, `filter=gguf&author=X&sort=downloads` plus `sort=createdAt`, so
   new releases show up. Then `expand[]` metadata and `tree` sizes for the candidates.
4. **Reject** automatically: names matching uncensored/abliterated/merge-soup patterns (configurable),
   no license or an unknown license, a `cardData.license` that disagrees with GGUF `general.license`
   or the upstream `baseModels` license (flag it for review: packager repos can mislabel), no `baseModels` link to an allowlisted upstream, `.gguf` missing,
   repos that need `trust_remote_code`, gated repos (v1).
5. **Rank** inside a use case: quality tier (curated) → recency of the **upstream** release → downloads
   and likes (log-scaled) → trending as a small "🆕 new" boost.
6. **Store** the result in Postgres (additive table `model_catalog`, refreshed in place) and serve it to
   the web as JSON. The runner never talks to the HF API for discovery.
7. **Sign**: the reviewed catalog (repo/sha/file/sha256 triples) is signed with an **offline key**.
   Its public key ships in the runner bundle (MA3 requirement).
8. **New and unreviewed** families can show in a separate "🧪 Discover (not reviewed)" list, collapsed,
   with a warning. Never as a best pick.

### 3.4 Memory-fit math

```
needed = weights + kv_cache(context) + compute_overhead + runtime_overhead
```

- **weights** = the **real GGUF file size** from `tree` (sum the shards). Don't use params × bpw when
  the file is there. Params × bpw is only for "what quant would fit" hints. Bits per weight measured from
  fetched files: `Qwen3-4B` (4.02B params) Q4_K_M 2.5 GB → ≈ 5.0 bpw, Q8_0 4.3 GB → ≈ 8.5 bpw;
  `Qwen3-Coder-30B-A3B` (30.5B) Q4_K_M 18.6 GB → ≈ 4.9 bpw, Q8_0 32.5 GB → ≈ 8.5 bpw.
- **kv_cache** = `2 × block_count × head_count_kv × head_dim × context × bytes_per_elem`
  (`bytes_per_elem` = 2 for f16 cache, ≈ 1 for q8_0, ≈ 0.56 for q4_0). Worked example, Qwen3-Coder-30B-A3B
  (48 layers, 4 KV heads, 128 dim, f16): **96 KiB per token → 3 GiB at 32k context, 12 GiB at 128k**.
  ⚠️ Hybrid/linear-attention architectures (e.g. `lfm2`, `qwen35`, sliding-window models) need
  per-architecture formulas. Until a formula is written and tested, mark them "≈ estimate".
- **compute_overhead**: a fixed 0.5 GiB + 5 % of weights (proposal; to calibrate against
  `llama-server` logs and Ollama `/api/ps` on real devices).
- **runtime_overhead / OS reserve**: see §2.2.
- **MoE models**: all experts must be in memory (size = full file), but speed tracks *active* params
  (e.g. `30B-A3B` runs like a ~3B for tokens/s).

**Fit tiers** against the **usable budget** from [§2.2](#22-memory-budget-per-platform) (per platform,
in GiB; never RAM + GPU memory added together when `sharesSystemRam` is true):

| Tier | Rule | UI |
|---|---|---|
| ✅ **Fits comfortably** | needed ≤ 75 % of budget at the default context (32k) | green, "Runs well" |
| 🟡 **Tight** | 75–95 %, or needs a smaller context / CPU offload | amber, "Will run, may be slow or need a short context" |
| ⛔ **Won't fit** | > 95 % even at 8k context | grey, hidden behind "Show models that don't fit" |

Separate from fit: any quant **below 3 bits** is labelled "Not recommended (< 3-bit)" and is never a
best pick, even when it fits.

Speed hint (optional, later): tokens/s ≈ memory bandwidth ÷ active-weight bytes, shown as "fast / ok /
slow", never as a promise.

### 3.5 Best pick per use case

| Use case | Picks from | Default context |
|---|---|---|
| 💬 Chat | tier-A instruct families, largest quant that is ✅ | 32k |
| 👩‍💻 Coding | coder families (e.g. `Qwen3-Coder`) | 64k |
| 👁️ Vision | `image-text-to-text` + an `mmproj-*.gguf` in the repo (e.g. `unsloth/Qwen3.8-27B-GGUF` has `mmproj-F16.gguf`, 0.93 GB) | 16k |
| ⚡ Small and fast | ≤ 4B, or MoE with ≤ 3B active | 8k |
| 🧭 Planner/router | see §5 | 8k |

Quant preference when several fit: Q8_0 / Q6_K → Q5_K_M → Q4_K_M → IQ4_XS. Never suggest < 3-bit as a
best pick.

---

## 4. One-click download and install

**Flow:** the owner clicks **Install** on the web. The server sends an install request. The runner checks,
downloads, verifies and registers the model in the local runtime, then reports progress.

```jsonc
// server → runner (only if the local runner config has installs enabled, see §6)
{ "type": "model.install", "id": "inst_…", "runtime": "ollama",
  "repo": "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
  "revision": "b17cb02dd882d5b6ab62fc777ad2995f19668350",   // REQUIRED, 40-hex commit sha
  "files": [ { "path": "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf",
               "size": 18556689568, "sha256": "…", "chatTemplateSha256": "…" } ],
  "license": { "id": "apache-2.0", "url": "https://huggingface.co/<repo>/blob/<revision>/LICENSE" },
  "catalogSig": "…" }                                          // signature over the catalog entry
// runner → server
{ "type": "model.install.progress", "id": "inst_…", "done": 1234, "total": 18600000000 }
{ "type": "model.install.done", "id": "inst_…", "localName": "qwen3-coder-30b-a3b:q4_k_m" }
{ "type": "model.install.error", "id": "inst_…", "code": "disk_full" | "checksum" | "refused" | … }
```

**Runner rules (enforced locally, not trusted from the server):**
0. **On-device confirmation, always.** Installs are off in the local runner config by default
   **and**, even when on, every install needs a local "yes" (a CLI prompt or device notification)
   showing repo@sha, file, size and license. A web click alone never installs anything.
1. **Pinned revision**: `revision` must match `^[0-9a-f]{40}$`. Branch or tag names (`main`, `v1`) are
   refused with `refused`. The entry (repo/revision/path/sha256) must be in the **signed catalog**,
   verified with the public key shipped in the runner bundle.
2. **Host allowlist**: download only from `https://huggingface.co/<repo>/resolve/<revision>/<path>`.
   Redirects are followed only to an **allowlisted CDN host** (`*.hf.co`, `cdn-lfs*.huggingface.co`;
   observed: `us.aws.cdn.hf.co`), https only, **at most 3 redirects**, and any `Authorization` header
   is stripped. Signed CDN URLs are **never logged**.
3. **GGUF only**: every `path` ends in `.gguf` (model or `mmproj`). Anything else is refused.
4. **Disk check first**: `free ≥ size × 1.1 + 5 GiB`, otherwise `disk_full` before downloading anything.
   Plus a **per-install max size** and a **daily byte cap** the owner sets on the device.
5. **SHA-256 + size**: stream-hash while downloading and compare both with the pinned tree entry
   (`lfs.oid`; the runner also cross-checks `x-linked-etag` / `x-linked-size`). Verify **before** the
   rename/registration. On a mismatch, delete the file and report `checksum`.
6. **Chat template check**: read the GGUF header (incremental range reads; 8 MiB was enough here,
   since the header used 5.94 MiB, but large-vocabulary models can need more, with a fallback to
   `expand[]=gguf`), hash `tokenizer.chat_template` and compare with `chatTemplateSha256` from the
   catalog. On a mismatch, refuse or flag it.
7. **Into the runtime** (with a **minimum runtime version** per runtime, checked locally):
   - **llama.cpp**: place it in the runner's models dir and add it to the offered models. (`llama-server -hf
     <user>/<model>[:quant]` exists, verified in `--help`, but we download ourselves so we control the
     hash and the disk.)
   - **Ollama**: push the blob with `POST /api/blobs/sha256:<digest>`, then `POST /api/create` with
     `files: {"<name>.gguf": "sha256:<digest>"}`. Both are in the Ollama API docs. Ollama also verifies
     digests on pull ("verifying sha256 digest"). **Use the blob path**, where Ollama re-checks the
     digest we pinned. Pulling `hf.co/<user>/<repo>:<quant>` resolves a moving tag, so it is **not
     used** (not tested here either).
   - **LM Studio**: `POST /api/v1/models/download` exists. Out of scope for v1.
8. **Resumable**, one install at a time, cancellable from the web and from the runner CLI.
9. Every install, refusal and uninstall goes to a **local audit log**, visible with
   `rakazo-runner inspect` (proposed extension).
10. After install, the model appears in **My hardware → Models**, **off** for sharing until the owner
   switches it on (same as M2a).

**Uninstall** is a separate, explicit action (and a runner CLI command). It's never automatic.

---

## 5. Planner / router model

### 5.1 Idea

```
user message ─▶ 🧭 planner (small, fast, always loaded)
                   ├─ "simple"  ─▶ answer with the planner itself (optional)
                   ├─ "complex" ─▶ 🧠 main model (big)
                   └─ "tool X"  ─▶ tool call, then main model
```

- The **planner** gets a short system prompt plus the latest turn(s) and returns **structured JSON** (Ollama
  `format` with a JSON schema, or llama.cpp grammar): `{route, reason, tools?, plan?}`.
- The **main model** does the real work. The planner never writes to the user unless "answer simple
  questions with the planner" is on.

### 5.2 Bot config

New optional fields on a bot (owner only):
- **Main model**: as today.
- **Planner model**: none (default) / one local model / one provider model.
- **Planner may answer directly**: off (default).
- Shown in bot settings as "🧭 Planner: LFM2.5-1.2B on Host-001 → 🧠 Main: Qwen3-Coder-30B on Host-001".

**Shared-local**: both models must be allowed on the device (`policy.allowedModels`). If they live on two
devices, each device's own grants apply. A shared-group member never learns which device runs the planner
(same privacy as M2a).

### 5.3 Fallbacks ("no silent fallback")

| Situation | Behaviour |
|---|---|
| Planner offline / errors / bad JSON | Go to the main model directly **and say so**: a small "🧭 planner skipped" marker on the reply, visible to the owner. |
| Main model offline | Friendly "This bot's computer is offline" notice (the M1 behaviour). **Never** reroute to the planner or to a cloud model. |
| Planner chooses a model the bot isn't allowed to use | Refuse. Ignore the choice and log it. |

### 5.4 Latency and cost

- One extra call per turn. A sub-2B planner on the same machine should cost little compared with a 30B
  answer, but **this is unmeasured**. MA4 includes measuring it on Host-001 (time-to-first-token with
  and without the planner).
- Keep the planner always loaded (Ollama `keep_alive`) so it doesn't pay a load time on each turn.
- Local → no money cost. A cloud planner (a provider model) uses the **bot owner's** key, like today.

### 5.5 Candidates (verified on HF 2026-10-13)

**Liquid AI (`LiquidAI/…`)**: all licensed `other` / `lfm1.0` = **LFM Open License v1.0**: Apache-style,
but **commercial use is only licensed below $10M annual revenue** (§5 of the license; non-profit research is exempt).
The UI must show this.

| Repo (GGUF) | Params | Q4_K_M size | Notes |
|---|---|---|---|
| `LiquidAI/LFM2.5-230M-GGUF` | 0.23B | – | tiniest |
| `LiquidAI/LFM2.5-350M-GGUF` | 0.35B | – | |
| `LiquidAI/LFM2.5-1.2B-Instruct-GGUF` | 1.17B | 0.73 GB | ⭐ default planner candidate, ctx 128,000, arch `lfm2` |
| `LiquidAI/LFM2.5-1.2B-Thinking-GGUF` | 1.17B | – | reasoning variant |
| `LiquidAI/LFM2.5-2.6B-GGUF` | 2.70B | – | |
| `LiquidAI/LFM2.5-8B-A1B-GGUF` | 8.47B (MoE, ~1B active) | 5.2 GB | smarter planner, still fast |
| `LiquidAI/LFM2-1.2B-Tool-GGUF`, `LFM2-1.2B-Extract-GGUF` | 1.2B | – | tool-call / extraction specialists (LFM2 gen) |

**Others (license from `cardData`)**

| Repo | Params | License |
|---|---|---|
| `Qwen/Qwen3-0.6B`, `Qwen/Qwen3-4B` (GGUF: `unsloth/Qwen3-4B-GGUF`, Q4_K_M 2.5 GB) | 0.75B / 4.02B | apache-2.0 |
| `HuggingFaceTB/SmolLM3-3B` | 3.08B | apache-2.0 |
| `ibm-granite/granite-4.1-3b`, `granite-4.2-8b` | 3.40B / 8.79B | apache-2.0 |
| `microsoft/Phi-4-mini-instruct` | 3.84B | mit |
| `google/gemma-3-1b-it`, `gemma-3-270m-it` | 1.00B / 0.27B | gemma (custom) |
| `meta-llama/Llama-3.2-1B-Instruct`, `-3B-Instruct` | 1.24B / 3.21B | llama3.2 (custom) |
| `nvidia/NVIDIA-Nemotron-3-Nano-4B-BF16` | 3.97B | nvidia-nemotron-open-model-license (custom) |

Default suggestion: **LFM2.5-1.2B-Instruct** where the LFM license is fine, with **Qwen3-4B (Apache-2.0)** as
the permissive alternative. Which one actually routes best is an open question (Q3).

Side note: the Ollama API docs list `capabilities: ["decision"]` on `POST /api/create` "for compatible
decision models". What that enables is not documented there; to investigate (Q4).

---

## 6. Security

- 🚫 **No code execution from the Hub, ever.** GGUF files only. No pickles, no `trust_remote_code`,
  no install scripts, no Python on the user's machine.
- ⚠️ **Chat templates are code-like**: GGUF carries a Jinja `chat_template` (verified in `expand[]=gguf`).
  llama.cpp (minja) and Ollama (Go-template conversion) use **restricted** engines, but that is not a
  sandbox guarantee. The Python `jinja2` path had a real SSTI → RCE (llama-cpp-python, CVE-2024-34359).
  Templates can also smuggle hidden system prompts or change the tool-call format, and malformed
  GGUF files have hit ggml parser bugs before. Requirements:
  - **never** use a Python Jinja renderer;
  - store `chat_template_sha256` at review time, and the runner checks it before loading (§4 rule 6);
  - optionally ship a known-good template (llama.cpp `--chat-template-file`, Ollama `TEMPLATE`);
  - enforce a **minimum runtime version** (parser fixes).

  Templates from non-allowlisted repos keep a model in the "🧪 Discover" list.
- 🔐 **Integrity**: the SHA-256 from the Hub (`lfs.oid` / `x-linked-etag`) is checked by the runner
  before the model is registered. The **revision is pinned** as a 40-hex commit sha in the catalog and
  in the install frame (§3.3, §4), so a repo update can't swap a file under an install.
- 🧱 **Compromised-server threat**: a hacked server could still pick *any* hash-valid GGUF on HF, fill
  the disk, or trigger installs over and over. Requirements (blocking for MA3):
  - installs disabled by default in the local runner config (`rakazo-runner config set installs on`,
    **proposed**: runner 0.2.1 only has `run/pair/start/stop/status/inspect/version`) **and** an
    on-device confirmation for every install;
  - only repo/sha/file triples from the **signed catalog** (offline key, public key in the runner
    bundle);
  - a per-install max size + a daily byte cap + one install at a time;
  - a local audit log visible in `inspect`.
- 📜 **Licenses** are always shown before install: the license **name** plus a link to the LICENSE
  file **at the pinned sha**. Custom licenses (LFM, Gemma, Llama, NVIDIA) need an explicit
  **"I accept"** with a plain-language summary (e.g. "Commercial use only if your organisation earns
  < $10M/yr"). The accepted license + sha is recorded per install. Gated repos are skipped in v1.
- 🙈 **Content risk**: "uncensored/abliterated" re-uploads are filtered from recommendations by default.
  The owner can still install anything manually; we just don't recommend it.
- 🔑 **No tokens on runners**: an optional HF token lives only on the server, is never logged, and
  is never sent to devices. Downloads stay anonymous. The runner **rejects any frame carrying
  credential-like fields** (`token`, `authorization`, `hf_…`). A test asserts that no `hf_` pattern
  appears in runner frames or logs (like the M2a leak counters).
- The loopback-only inference rule from M1/M2 is unchanged. Downloads are outbound HTTPS only, and no ports open.

---

## 7. UX in My hardware

ADHD-friendly: one decision per screen, icons **and** words, short lines, nothing important hidden in a
tooltip.

```
┌ 🖥️ Host-001 · 🟢 online ──────────────────────────────────────┐
│ 🧠 128 GB unified · RDNA 3.5 APU (Vulkan) · 💾 > 1 TB free    │
│ [ 🔍 What can this computer run? ]                             │
└────────────────────────────────────────────────────────────────┘

  💬 Chat   👩‍💻 Code   👁️ Vision   ⚡ Fast   🧭 Planner      ← tabs

  ⭐ BEST PICK
  ┌──────────────────────────────────────────────────────────┐
  │ Qwen3-Coder 30B (A3B) · Q8_0 · 32.5 GB                   │
  │ ✅ Runs well · 77 GB left · ⚡ usually fast (MoE) · 📜 Apache-2.0 │
  │ [ ⬇️ Install ]   Why this one? ▸                          │
  └──────────────────────────────────────────────────────────┘
  Also good:  ✅ … · ✅ … · 🟡 …      [ Show models that don't fit ▸ ]
  Installed:  ✔ gemma4:26b-a4b · ✔ qwen2.5:3b
```

- Decorative emoji are `aria-hidden`; every chip carries its meaning in text.
- **"Memory left"** is on the card itself, not only under "Why this one?". Speed words are hedged
  ("usually fast"), never promises.
- **Three-colour fit chips with text** (✅ Runs well / 🟡 Tight / ⛔ Too big), not colour alone, with aria labels.
- **"Why this one?"** expands one paragraph: size, memory left, license, upstream, last updated.
- **Install** shows one confirm sheet with:
  - size, approximate download time, and disk left after install;
  - fit tier and context ("✅ Runs well at 64k");
  - which runtime it goes into (Ollama / llama.cpp);
  - license (+ "I accept" for custom licenses), "from huggingface.co/<repo>@<short sha>";
  - "checksum **will be** verified" (not "verified" before the download);
  - "it stays **off** for sharing until you switch it on";
  - how to uninstall;
  - "Confirm on your computer too" (the on-device step, §4 rule 0).

  Then a single progress bar with an ETA and a cancel button.
- **Planner tab** explains the idea in two lines before any choice.
- The hardware details line is collapsible. "What did my computer share?" shows the exact JSON.
- Copy must be localized (EN / IT / TR, Rakijazios suffix rules apply).

---

## 8. Milestones (after M2, before M5)

| | Milestone | Scope |
|---|---|---|
| **MA1** | 🔍 Detect and show | runner `hardware` frame (opt-in, coarse), My hardware shows the summary. No recommendations. |
| **MA2** | 📚 Recommend | server catalog + allowlist + fit tiers + best picks, read-only ("install it yourself with this command"). |
| **MA3** | ⬇️ One-click install | `model.install*` frames, runner download + SHA-256 + disk check, Ollama/llama.cpp registration, local opt-in. |
| **MA4** | 🧭 Planner / router | bot "Planner model" setting, structured routing, visible skip marker, latency measured on Host-001. |

M5 (device app with a bundled llama.cpp and "model chosen by device RAM") reuses MA1–MA3 directly.

---

## 9. Open questions

1. **Allowlist ownership**: who reviews additions (PR-reviewed JSON in this repo?), and how fast do new
   families get in?
2. **Quality ranking**: hand-set tiers only, or also import public leaderboards? Which, and with what license?
3. **Best planner**: LFM2.5-1.2B vs Qwen3-4B vs Granite-4.1-3B on *our* routing prompts. A small eval set is needed.
4. Ollama's `capabilities: ["decision"]`: what does it do, and does it help here?
5. **KV formulas** for hybrid architectures (`lfm2`, `qwen35`, sliding window): take them from llama.cpp's
   code, or measure empirically per family?
6. **Unified-memory budget** on Windows iGPUs and macOS: are our rules right? Calibrate on real devices.
7. ~~Ollama install path?~~ **Decided:** blob push with the pinned digest (§4). `hf.co/…` pulls resolve a moving tag.
8. **Revision pinning vs freshness**: when a packager re-uploads a fixed quant, do we auto-offer the update?
9. ~~Custom licenses: chip or "I accept"?~~ **Decided:** explicit "I accept" with a plain summary (§6).
10. **Gated repos** (Llama etc.): skip forever, or let the owner use their own HF token on the device?
11. Do we show **speed estimates** at all, given they can mislead?
12. Should the catalog refresh run in the `worker` service (existing) or a new cron?

13. **On-device confirmation UX**: a CLI prompt is fine for headless nodes, but desktops need a
    notification or tray prompt. Which one before M5?
    *Proposed (Rakazo Tester):* a CLI `rakazo-runner approve <id>` plus a desktop notification; a
    request expires after ~15 min; a tray prompt comes with the M5 app.
14. **Catalog signing**: who holds the offline key, how it is rotated, and what a runner does with an
    expired signature.
    *Proposed:* an offline Ed25519 owner key; the runner trusts the current and the next public key
    (for rotation); an expired signature keeps installed models working but refuses new installs.
15. Is "local fit computation only" (no hardware report at all) enough for every UI, or does the web
    need the coarse report for anything?
    *Proposed:* fit is computed on the device by default; the coarse report is a separate opt-in.
16. Measured download-time estimates: from what bandwidth figure, without leaking it?
    *Proposed:* before the download, show only a size-based range; during it, an ETA computed on the
    device; the bandwidth figure is never sent to the server.
---

## 10. Feasibility check on Host-001

Read-only probes on 2026-10-13. Nothing was installed, downloaded or changed.

**What detection would report (coarse):**

```jsonc
{ "os": "linux", "arch": "x64",                       // Fedora Linux 44, kernel 7.2
  "cpu": { "cores": 16, "threads": 32, "simd": ["avx2", "avx512"] },  // AMD Ryzen AI MAX+ 395
  "memory": { "totalPhysicalGiB": 128, "osVisibleGiB": 64 },   // OS sees 62.4 GiB (the rest is the carve-out)
  "accelerators": [ { "vendor": "amd", "family": "RDNA 3.5 APU", "kind": "apu-carveout",
                      "backend": "vulkan", "deviceMemGiB": 128, "sharesSystemRam": true,
                      "source": "llama.cpp" } ],
  "budgetGiB": 110,
  "runtimes": [ "ollama", "llama.cpp" ],
  "diskFree": ">1000" }
```

**Lesson: sources disagree on unified memory.** `rocm-smi`: VRAM 68,719,476,736 B (64 GiB carve-out).
sysfs: `mem_info_vram_total` 65,536 MiB, `mem_info_gtt_total` 63,917 MiB (kernel `amdgpu.gttsize=126976`).
llama.cpp Vulkan: 129,453 MiB = 65,536 + 63,917, i.e. carve-out + GTT. `free`: 62.4 GiB system RAM.
**GTT is not extra memory**: it is the OS's own 62.4 GiB mapped for the GPU, so the physical total
stays 128 GiB (≈ 126.4 GiB visible), and anything above the 64 GiB carve-out comes out of OS RAM.
Rule ([§2.2](#22-memory-budget-per-platform), Linux APU with carve-out): budget = (64 + 62.4) GiB
minus the desktop OS reserve. That reserve is max(16 GiB, 10 % ≈ 12.8 GiB) = **16 GiB** (Host-001
already uses ~9 GiB plus cache for docker, Chrome and Ollama), so the budget is **≈ 110 GiB**, under the runtime cap (126.4 GiB) and the
GTT cap (`ttm.pages_limit` = 124 GiB). The ✅ line (75 %) is ≈ 83 GiB.
`rocminfo` is not installed, so ROCm probing must be optional.

**Example recommendations** (sizes from `tree` in GB, licenses from `cardData`, live 2026-10-13; tiers
use the §3.4 rules against the 110 GiB budget, at each use case's default context from §3.5;
illustration only, not a curated list):

| Use | Model (repo · quant) | File | + KV / overhead | Tier on Host-001 | License |
|---|---|---|---|---|---|
| 💬👁️ Chat + vision | `unsloth/Qwen3.8-27B-GGUF` · UD-Q8_K_XL (+ `mmproj-F16` 0.93 GB) | 31.5 GB | ≈ estimate (hybrid arch `qwen35`) | ✅ | apache-2.0 |
| 👩‍💻 Coding | `unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF` · Q8_0 | 32.48 GB (30.25 GiB) | KV 6 GiB @ **64k** + ≈ 2 GiB overhead | ✅ ≈ 38 GiB of 110 @64k (≈ 44 GiB @128k) | apache-2.0 |
| 🧠 Big | `unsloth/gpt-oss-120b-GGUF` · Q4_K_M (all quants are 62.6–65.4 GB; the weights ship in MXFP4) | 62.8 GB (58.5 GiB) | + a few GiB | ✅ (≈ 57 %) | apache-2.0 |
| 🚫 Not recommended (< 3-bit) | `unsloth/GLM-5.3-Flash-GGUF` · smallest UD-IQ1_S | 93.1 GB (86.7 GiB) | + KV | 🟡 (≈ 79 %) but < 3-bit, so never a pick; Q4 (199.7 GB) is ⛔ | mit |
| 🧭 Planner | `LiquidAI/LFM2.5-1.2B-Instruct-GGUF` · Q4_K_M | 0.73 GB | tiny | ✅ | lfm1.0 (< $10M revenue) |

Already in Ollama on Host-001: `gemma4:26b-a4b-it-q4_K_M` (18.0 GB), `gemma4:e4b` (9.6 GB), two
`gemma4-e4b` fine-tunes (5.8 GB), `qwen2.5:3b` (1.9 GB). The advisor would mark these "✔ installed".

**Verdict:** feasible. Every input the recommender needs (sizes, hashes, licenses, architecture, layer and
head counts) is available from public, unauthenticated HF endpoints within rate limits, and both local
runtimes expose enough to place and verify models.

---

## 11. How to re-check the facts

```bash
U=https://huggingface.co/api/models
curl -sI "$U?limit=1" | grep -i ratelimit                                    # api bucket (anonymous 500/300s)
curl -s "$U?filter=gguf&sort=trendingScore&limit=5" | jq '.[].id'            # raw trending
curl -s "$U?filter=gguf&num_parameters=min:20B,max:40B&limit=5" | jq '.[].id'
curl -s "$U?author=LiquidAI&sort=downloads&limit=50&expand[]=cardData" | jq '.[] | [.id, .cardData.license_name]'
curl -s "$U/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF?expand[]=gguf&expand[]=cardData" | jq '.gguf | del(.chat_template)'
curl -s "$U/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF?expand[]=sha" | jq .sha                  # 40-hex pin
curl -s "$U/unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF/tree/main?recursive=true" | jq '.[] | [.path, .size, .lfs.oid]'
curl -s "$U?apps=bogus&limit=1"                                               # lists the allowed apps
curl -sI https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-Q4_K_M.gguf | grep -iE 'x-linked|ratelimit'
curl -sL https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct/resolve/main/LICENSE | grep -n Threshold
llama-server --list-devices        # on the device
```

(With curl, `expand[]` may need `-g` or `%5B%5D` encoding. These commands use `main` for convenience.
Production code uses the pinned 40-character `sha` only.)
