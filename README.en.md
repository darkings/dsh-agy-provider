# dsh-agy-provider

[简体中文](README.md) · [English](README.en.md)

Expose the locally authenticated **AGY CLI** as a model Provider for [DSH](https://github.com/darkings/dsh).

The project lets DSH use the models and quota available to the user's AGY account while keeping DSH's conversations, Sessions, Web mode, and headless mode. The Provider does not call the Google Gemini API directly and does not store OAuth credentials. Authentication and model selection remain owned by the local agy CLI; 0.6.x legacy tools are AGY-owned, while actual tool execution in the 0.7.0 DSH-owned bridge remains in DSH ToolRuntime.

## Project status

**0.10.0 is complete and is being published to npm.** Building on 0.9.0's settings panel, workspace auto-detection, and model/effort separation, 0.10.0 adds **optimized-full context budgets, deterministic tool-result eviction, privacy-safe diagnostics, and a Windows no-console launcher**; `sessionMode: full` remains the default.

**0.7.0 / 0.8.0 merged:** `v0.7.0 → b94fa32` (`latest=0.7.0` released), `v0.8.0 → b7c9a45` merged to main. Since 0.7.0 the bundle defaults to `dsh-owned` (DSH Session/ToolRuntime/sandbox/approval own the project and permissions).

0.10.0 highlights:

- Context and tool safety: DSH-owned structured prompts use a 56 KiB fail-closed limit, return `AGY_INPUT_TOO_LARGE` when exceeded, recover after compaction, and evict whole tool-result segments deterministically.
- Performance and observability: stable prefixes, canonical tool schemas, step-level usage accounting, and fingerprint diagnostics improve cache eligibility and make failures auditable without promising backend `cacheRead` hits.

- Settings panel: full `zh-CN/en` i18n via schemastery `.i18n`, `registerConfigurableProviders(settingsNs dsh-agy-provider)` + `registerModelDiscovery`, multi-select visible models and independent reasoning effort dropdown.
- Workspace-transparent: `workspaceRoot` deprecated (`.deprecated()`, hidden when `dsh-owned`), tool calls use DSH Session `header.cwd + workspaceRegistry + sandboxPolicy` transparently; pure text needs no workspace, tool without workspace returns actionable `DSH_WORKSPACE_MISMATCH`.
- Model/effort split: `gemini-3.7-flash` as base, `reasoningEffort: low|medium|high` separately; `listModels` returns bases with `reasoning.efforts`, legacy `-high/-medium/-low` suffix auto-compat with `DEPRECATED_MODEL_EFFORT_SUFFIX`.
- Model visibility: `visibleModels: string[]` empty = all, non-empty = only checked bases (explicit request still compat).
- Keeps the 0.7.0 DSH-owned tool bridge, Agent presets, doctor v5 (`profileSchemaVersion: 4`), zero retries, quota-free diagnostics, and cross-platform gates; `imageInput: experimental` now has an end-to-end multimodal path.

The image bridge remains experimental. When enabled it advertises `inputModalities: ['text', 'image']` and uses a dedicated `dsh-agy-image-view` Agent for staged images. Real pixel answers, same-session follow-ups, stable failures, and cleanup were verified in DSH Desktop; this is still not an unconditional production image capability.

## Architecture

~~~text
User / DSH Web / DSH headless
              │
              ▼
      dsh-agy-provider
      ├─ DSH LlmAdapter
      ├─ Prompt / stream mapping
      ├─ Session / Conversation mapping
      ├─ Model discovery / retry / telemetry
      └─ Agent and workspace safety boundaries
              │
              ▼
      agy --output-format stream-json
              │
              ▼
      AGY account quota, models, and Agent tools
~~~

The Provider starts AGY with spawn(executable, args), without shell command composition. It incrementally parses AGY's line-delimited output and converts it into DSH text, usage, finish, and stable error events.

## Implemented in 0.6.0

### Text Provider and process boundary

- Deterministically serializes DSH system/messages into an AGY prompt.
- Maps step_update.text_delta and result.response to DSH text streaming.
- Handles timeouts, cancellation, exit codes, parse errors, output limits, and process-tree cleanup.
- Emits whitelist-only lifecycle metadata; prompts, raw stderr, credentials, and complete local paths are not logged.

### Sessions, models, and reasoning

- sessionMode: full is the default and sends the complete DSH history on each turn.
- sessionMode: resume can use an AGY conversation_id and falls back to full history if resume is invalid.
- Calls for the same DSH Session are serialized; different Sessions can run concurrently.
- agy models discovery is quota-free and supports TTL, single-flight refresh, cache, and static fallback.
- Request-level reasoningEffort supports low, medium, and high and is forwarded as a separate --effort argument. No implicit effort is selected.

### Tool ownership and permissions

The project keeps one tool executor:

- Programmatic Provider defaults to toolPolicy: reject and returns UNSUPPORTED_TOOLS for DSH tool schemas.
- The published 0.7.0 profile bundle defaults to toolPolicy: dsh-owned; DSH schemas are bounded and validated locally, while DSH ToolRuntime remains the only executor. The 0.6.1 profile remains the explicit agy-owned legacy path.
- Permission requests return PERMISSION_REQUIRED and terminate the request. The Provider never auto-approves permissions or uses --dangerously-skip-permissions.

### Agent capability presets and read/write access

The package ships three Agent templates:

| preset | Allowed capabilities | Default behavior |
|---|---|---|
| tool-free | Text reasoning only | No workspace access |
| read-only | find_by_name, grep_search, view_file, list_dir | Read-only workspace |
| workspace-write | The read-only tools plus multi_replace_file_content, replace_file_content, write_to_file | Writes only inside an explicit workspace |

workspace-write is implemented, but it requires an existing, non-root workspaceRoot. It does not include shell, network, browser, MCP, subagent, or permission-bypass capabilities.

The project does not publish an unverified glob tool name. File search uses the verified AGY tools find_by_name, grep_search, and list_dir.

Agent installation previews by default and writes only with --apply:

~~~powershell
npx dsh-agy-provider agents list
npx dsh-agy-provider agents install read-only --dir "$HOME/.gemini/config/agents"
npx dsh-agy-provider agents install read-only --dir "$HOME/.gemini/config/agents" --apply
~~~

Existing templates are not overwritten by default. Use --backup explicitly when the previous file must be preserved.

### Doctor v3 and safe diagnostics (0.7.0)

The package provides a profile-aware doctor:

~~~powershell
npx dsh-agy-provider doctor --profile web --json
~~~

The 0.7.0 doctor reports `profileSchemaVersion: 3` and audits the effective provider, model, Agent, retry, purpose routes, workspace, DSH context probe state, and DSH-owned bridge capability. It distinguishes dump timeouts, non-zero exits, and parse failures, and emits a deprecated warning for `agy-owned`; profile doctor is read-only and never presents a static dump as a live Session.

The runtime `diagnoseDshContext()` API returns only session/workspace/sandbox/permission/approval availability, allowlisted permission modes, and stable issue codes such as `DSH_SESSION_UNKNOWN` and `DSH_WORKSPACE_MISMATCH`. It never returns paths, Session IDs, prompts, or tool arguments. Telemetry is limited to `permissionPreset`, `sandboxMode`, `approvalPolicy`, `toolSchemaCount`, `toolCallCount`, and bridge outcome.

doctor only runs agy --version, agy agents, agy models, and a DSH config dump. It never sends a model prompt or executes tools, and quotaUsed is always false.

### Experimental image boundary

imageInput: experimental supports:

- Reading images through an optional DSH AttachmentStore.
- MIME, byte-size, and image-count limits for PNG/JPEG/WebP/GIF.
- A random per-request staging directory with cleanup on success, failure, and cancellation.
- Image turns force the dedicated `dsh-agy-image-view` Agent and allow only `view_file` for the exact staged paths of that request.
- Image turns use one-shot mode. AGY's internal `view_file` lifecycle is allowed only inside that narrow boundary; DSH tools remain owned by DSH ToolRuntime.

With `imageInput: experimental`, `listModels()` advertises text and image input; with `off`, it remains text-only. Unknown custom Agents never receive image-read permission.

### Quality gates

- npm run verify: typecheck, 158 tests, and pack dry-run.
- npm run benchmark: quota-free Parser, serializer, and limiter baselines.
- npm run smoke:dsh:self-contained: isolated DSH Web/headless plugin-add, doctor, and Mock response.
- GitHub Actions: Provider Node.js 20/22/24 on Windows/Ubuntu/macOS, DSH-native Node 22/24 on Windows/Ubuntu/macOS, and the self-contained smoke.
- CI, doctor, benchmark, and Mock smoke do not call a real AGY model.

## Capability matrix

| Capability | Status | Default |
|---|---|---|
| DSH text conversations | Implemented | Enabled in the profile bundle |
| AGY authentication/quota | Implemented | Owned by local AGY |
| Dynamic model discovery | Implemented | modelDiscovery: auto |
| Reasoning effort | Implemented | No implicit effort |
| AGY-owned tools | Implemented (0.6.1 legacy) | agy-owned in the 0.6.1 profile bundle |
| DSH tool-call bridge | Implemented and covered by cross-platform gates in 0.7.0 | dsh-owned since 0.7.0 |
| read-only Agent | Implemented | Explicit installation/configuration |
| workspace-write Agent | Implemented | `dsh-owned` needs no manual `workspaceRoot`; legacy `agy-owned` still requires explicit dir |
| Image staging bridge | Experimental in 0.9.0; Desktop loop verified | imageInput: experimental in the bundle |
| Image modality | Limited public capability | text+image when experimental; text-only when off |
| Persistent stream transport | Implemented opt-in in 0.8.0 | `one-shot` by default, explicit `transport: persistent` reuses worker |
| Model visibility | Implemented in 0.9.0 | `visibleModels: []` empty = all, non-empty = checked bases |
| Settings panel | Implemented in 0.9.0 | `zh-CN/en` i18n, multi-select + base/effort split |
| Workspace-transparent | Implemented in 0.9.0 | `workspaceRoot` deprecated under `dsh-owned`, DSH Session cwd auto-used |

## Installation and usage

### Requirements

- Node.js >=20.
- The local AGY CLI is installed, logged in, and available as agy on PATH.
- pnpm must be available when installing through the DSH profile plugin manager.

### Install into a DSH profile

A normal npm install only installs the Node.js package. It does not modify a DSH profile. Use the native DSH plugin manager:

~~~powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.10.0
npx @deepseek-ai/dsh plugin --profile headless add dsh-agy-provider@0.10.0
~~~

The 0.9.0 bundle defaults (`cordis.patch.yml`) are equivalent to:

~~~yaml
enabled: true
provider: agy
model: gemini-3.1-pro
agent: deepseek-proxy
toolPolicy: dsh-owned
sessionMode: full
imageInput: off
~~~

Direct library `Config({})` remains `enabled: false, toolPolicy: reject`. Importing the package does not modify a user's DSH profile; `BundleConfig` is the explicit `enabled: true / dsh-owned`.

The 0.6.1 `toolPolicy: agy-owned` path remains available for legacy rollback, and doctor reports `PROFILE_TOOL_POLICY_DEPRECATED`. Since 0.9.0 `dsh-owned` no longer requires `workspaceRoot`; the active DSH Session and ToolRuntime control the project, read/write, shell, network, MCP, and approval behavior (`DSH_WORKSPACE_MISMATCH` is actionable).

### Agent preset configuration

Read-only (`dsh-owned` needs no `workspaceRoot`):

~~~yaml
agentPreset: read-only
toolPolicy: dsh-owned
# no workspaceRoot needed; open the folder in DSH and the Session cwd is the project
~~~

Workspace write (`dsh-owned` still needs no manual dir; DSH permission preset decides):

~~~yaml
agentPreset: workspace-write
toolPolicy: dsh-owned
# dsh-owned: workspaceRoot deprecated, DSH workspace-write / danger-full-access decides the boundary
~~~

Legacy `agy-owned` with explicit dir (not recommended):

~~~yaml
agentPreset: workspace-write
toolPolicy: agy-owned
workspaceRoot: C:\work\my-project
~~~

Write access is enforced by DSH permission preset and sandbox; the provider does not bypass it.

### Configuration example (0.9.0 recommended)

~~~yaml
enabled: true
provider: agy
agent: deepseek-proxy
model: gemini-3.7-flash            # base id, pick reasoningEffort low/medium/high per-session in DSH
visibleModels:                      # panel-checked models, empty = all
  - gemini-3.7-flash
  - gemini-3.1-pro
models:
  - id: gemini-3.7-flash
    name: Gemini 3.7 Flash
  - id: gemini-3.1-pro
    name: Gemini 3.1 Pro
toolPolicy: dsh-owned
transport: one-shot                 # or persistent (opt-in, one worker per Session)
sessionMode: full
modelDiscovery: auto
retryPolicy:
  maxRetries: 5
  retryableCodes: [EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]
imageInput: off
~~~

> Compat: legacy `model: gemini-3.7-flash-high` still resolves to `base + high` with a warning; prefer base + per-session `reasoningEffort`.

Retries follow the DSH normal policy by default: up to five retries after the initial request, including `TIMEOUT` (at most six AGY requests total). `retryPolicy` can narrow the count and error-code allowlist in `settings.yaml`.

## Diagnostics and development

Quota-free diagnostics:

~~~powershell
npm run diagnose -- --json
npx dsh-agy-provider doctor --profile web --json
npx dsh-agy-provider agents list
~~~

Local development:

~~~powershell
npm ci
npm run verify
npm run benchmark
npm run smoke:dsh:self-contained
~~~

Experiments that call a real AGY model never run automatically. The 0.9.0 multimodal loop was completed under explicit quota authorization; future runs must not consume real-model quota again without authorization.

## Roadmap

Future work follows the same rules: verifiable behavior, safe fallback, and bounded quota use.

### 0.7.0: DSH-controlled workspace, permissions, and tools (implemented)

- The base DSH-owned tool bridge is implemented: AGY emits locally validated DSH tool calls, while DSH ToolRuntime executes filesystem, shell, network, and MCP tools.
- The V7-M4 permission matrix and cross-platform CI, V7-M5 doctor v3/allowlisted telemetry/security regressions, and V7-M6 packed artifact/Web/headless/release gates are complete.
- Use the DSH Session project `cwd` and its `read-only`, `workspace-write`, or `danger-full-access` selection instead of duplicating switches in this plugin.
- Keep sandboxing, approval, MCP credentials, and side effects inside DSH; the Provider does not pass `--dangerously-skip-permissions`.
- See the [0.7.0 development plan](docs/v0.7.0-development-plan.md) for scope, security gates, quota budget, and milestones.

### 0.8.0: persistent transport and DSH next compatibility (implemented)

- AGY 1.1.15's official `stream-json` input as a stable, session-affine opt-in transport; one-shot remains the default (`transport: persistent` explicit).
- Validated both DSH rc.7 stable and rc.8 next isolated lanes without breaking stable; warm-turn 79% improvement, 145/145.
- Delivered image modality as a limited 0.9.0 experimental capability, with Desktop pixel answers, follow-ups, stable failures, and cleanup verified.
- See the [0.8.0 development plan](docs/v0.8.0-development-plan.md) for scope, go/no-go criteria, quota budget, and release gates.

### 0.9.0: settings panel + workspace-transparent + model parity (implemented)

- Settings panel: `Config` i18n (`zh-CN/en`) + `registerConfigurableProviders` + `registerModelDiscovery`, `visibleModels` multi-select and `base + reasoningEffort` split.
- Workspace-transparent: `workspaceRoot` deprecated under `dsh-owned`, project auto-owned by DSH Session, text needs no workspace.
- Full 7-layer tests (L1 160+ / L2 integration / L3 self-contained / L4 permission matrix / L5 settings panel / L6 cross-platform / L7 real sampling) and `doctor v5` (`profileSchemaVersion 4`).
- See [0.9.0 development plan](docs/v0.9.0-development-plan.md) and [0.9.0 migration guide](docs/migration-0.9.0.md).

### Later: image and tool UX hardening

- Continue hardening the DSH Web AttachmentStore → AGY pixel-answer path for performance, more formats, and cross-platform evidence.
- Improve workspace-write conflict handling, backup, rollback, and tool-call presentation.
- Never bypass the DSH session permission preset merely because a write tool exists in the catalog.

### Later: transport and cost optimization

- 0.8.0 persistent transport already passed real AGY protocol, isolation, crash recovery, process cleanup and token-cost gates (`V8-M4 go`); 0.9.0 keeps it opt-in.
- Continue purpose-aware compaction/session-title routing, usage observability and evaluation of default `persistent`.
- Keep CI, doctor, parser, and Mock smoke quota-free.

## Explicit non-goals

- Calling the Gemini API directly or managing OAuth/refresh tokens inside the plugin.
- A dual DSH/AGY tool-execution loop.
- Unverified glob, shell, network, MCP, subagent, or automatic permission approval capabilities.
- Default writes to a user's workspace.
- Unrestricted production image modality, temperature, stop, maxTokens, or unverified reasoning-delta output.
- Production persistent stream transport before cost and reliability evidence exists.

## Project structure

~~~text
dsh-agy-provider/
├─ src/
│  ├─ provider/       # DSH Adapter, config, serialization, image bridge
│  ├─ agy/            # process, argv, stream-json, discovery, redaction (incl. persistent-transport)
│  ├─ session/        # DSH Session to AGY Conversation mapping
│  ├─ doctor.ts       # profile-aware doctor v5 (profileSchemaVersion 4)
│  ├─ dsh/context.ts  # DSH Session/workspace/sandbox/approval transparent check
│  └─ agent-*.ts      # presets, installer, and agents CLI
├─ agents/            # tool-free/read-only/workspace-write templates
├─ scripts/           # verify, benchmark, diagnose, and DSH smoke
├─ tests/             # L1 unit + L2 integration (visibleModels/normalization/i18n)
├─ docs/
├─ cordis.patch.yml
└─ package.json
~~~

## Documentation

- [Installation](docs/installation.md) (0.9.0 workspace-transparent & `visibleModels`)
- [0.9.0 migration guide](docs/migration-0.9.0.md) (base+effort / visibility / deprecated workspaceRoot)
- [0.9.0 development plan](docs/v0.9.0-development-plan.md) (panel/workspace/parity/7-layer tests)
- [0.9.0 release checklist](docs/v0.9.0-release-checklist.md) (L1~L7 gates)
- [Tool capability matrix](docs/tool-capability-matrix.md)
- [Compatibility matrix](docs/compatibility-matrix.md)
- [DSH Provider contract](docs/dsh-provider-contract.md)
- [0.8.0 / 0.7.0 development plans & migration guides](docs/v0.8.0-development-plan.md) (history)
- [CHANGELOG](CHANGELOG.md)
- [Performance baseline](docs/performance-baseline.md)

## License

MIT
