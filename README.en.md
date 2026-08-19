# dsh-agy-provider

[简体中文](README.md) · [English](README.en.md)

Expose the locally authenticated **AGY CLI** as a model Provider for [DSH](https://github.com/darkings/dsh).

The project lets DSH use the models and quota available to the user's AGY account while keeping DSH's conversations, Sessions, Web mode, and headless mode. The Provider does not call the Google Gemini API directly and does not store OAuth credentials. Authentication and model selection remain owned by the local agy CLI; 0.6.x legacy tools are AGY-owned, while actual tool execution in the 0.7.0 DSH-owned bridge remains in DSH ToolRuntime.

## Project status

Version 0.6.1 is publicly released as the compatibility-fix release for 0.6.0. It fixes plugin startup when the DSH profile does not provide `AttachmentStore`; all 0.6.0 capabilities and configuration remain compatible. The `v0.6.1` tag, GitHub Actions CI, and npm Trusted Publishing have passed.

The repository is now developing 0.7.0. npm `latest` is still 0.6.1 and 0.7.0 has not been published. The DSH-owned bridge, permission matrix, and cross-platform quota-free CI gates are complete; the current stage hardens doctor v3, telemetry, and security regressions.

The 0.6.0 focus is:

- A bounded AGY child-process and stream-json text adapter.
- Safe DSH Session to AGY Conversation mapping.
- agy models discovery with TTL, cache, and static fallback.
- Explicit low/medium/high reasoning effort forwarding.
- AGY-owned tool policy, Agent capability presets, and doctor v2.
- Zero automatic retries by default, quota-free diagnostics, and cross-platform gates.

A restricted experimental image bridge exists, but the public model catalog still declares inputModalities: ['text']. The project will not advertise production image understanding until the DSH Web AttachmentStore, AGY view_file, and real pixel-answer path are all verified.

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
- The published 0.6.1 profile bundle defaults to toolPolicy: agy-owned. The 0.7.0 development branch switches the bundle to toolPolicy: dsh-owned; DSH schemas are bounded and validated locally, while DSH ToolRuntime remains the only executor.
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

### Doctor v3 and safe diagnostics (0.7.0 source)

The package provides a profile-aware doctor:

~~~powershell
npx dsh-agy-provider doctor --profile web --json
~~~

The 0.7.0 source doctor reports `profileSchemaVersion: 3` and audits the effective provider, model, Agent, retry, purpose routes, workspace, DSH context probe state, and DSH-owned bridge capability. It distinguishes dump timeouts, non-zero exits, and parse failures, and emits a deprecated warning for `agy-owned`; profile doctor is read-only and never presents a static dump as a live Session.

The runtime `diagnoseDshContext()` API returns only session/workspace/sandbox/permission/approval availability, allowlisted permission modes, and stable issue codes such as `DSH_SESSION_UNKNOWN` and `DSH_WORKSPACE_MISMATCH`. It never returns paths, Session IDs, prompts, or tool arguments. Telemetry is limited to `permissionPreset`, `sandboxMode`, `approvalPolicy`, `toolSchemaCount`, `toolCallCount`, and bridge outcome.

doctor only runs agy --version, agy agents, agy models, and a DSH config dump. It never sends a model prompt or executes tools, and quotaUsed is always false.

### Experimental image boundary

imageInput: experimental supports:

- Reading images through an optional DSH AttachmentStore.
- MIME, byte-size, and image-count limits for PNG/JPEG/WebP/GIF.
- A random per-request staging directory with cleanup on success, failure, and cancellation.
- Entry only for built-in read-only/workspace-write Agents whose whitelist includes view_file; otherwise IMAGE_AGENT_UNSUPPORTED is returned.

This is a protocol experiment, not a public image capability. listModels() remains text-only, and deepseek-proxy or an unknown custom Agent is never advertised as an image Agent.

### Quality gates

- npm run verify: typecheck, 110 tests, and pack dry-run.
- npm run benchmark: quota-free Parser, serializer, and limiter baselines.
- npm run smoke:dsh:self-contained: isolated DSH Web/headless plugin-add, doctor, and Mock response.
- GitHub Actions: Node.js 20/22/24 on Windows/Ubuntu/macOS, including the DSH self-contained smoke.
- CI, doctor, benchmark, and Mock smoke do not call a real AGY model.

## Capability matrix

| Capability | Status | Default |
|---|---|---|
| DSH text conversations | Implemented | Enabled in the profile bundle |
| AGY authentication/quota | Implemented | Owned by local AGY |
| Dynamic model discovery | Implemented | modelDiscovery: auto |
| Reasoning effort | Implemented | No implicit effort |
| AGY-owned tools | Implemented (0.6.1 legacy) | agy-owned in the 0.6.1 profile bundle |
| DSH tool-call bridge | Base loop implemented in unreleased 0.7.0 | dsh-owned in the source bundle |
| read-only Agent | Implemented | Explicit installation/configuration |
| workspace-write Agent | Implemented | Requires explicit workspaceRoot |
| Image staging bridge | Experimental | imageInput: off |
| Public image modality | Not implemented | Text-only |
| Persistent stream transport | Fixture prototype | One-shot in production |

## Installation and usage

### Requirements

- Node.js >=20.
- The local AGY CLI is installed, logged in, and available as agy on PATH.
- pnpm must be available when installing through the DSH profile plugin manager.

### Install into a DSH profile

A normal npm install only installs the Node.js package. It does not modify a DSH profile. Use the native DSH plugin manager:

~~~powershell
npx @deepseek-ai/dsh plugin --profile web add dsh-agy-provider@0.6.1
npx @deepseek-ai/dsh plugin --profile headless add dsh-agy-provider@0.6.1
~~~

The published 0.6.1 profile bundle defaults are equivalent to:

~~~yaml
enabled: true
provider: agy
agent: deepseek-proxy
toolPolicy: agy-owned
sessionMode: full
imageInput: off
~~~

Direct library Config({}) remains enabled: false and toolPolicy: reject. Importing the package does not modify a user's DSH profile.

The unreleased 0.7.0 source bundle defaults to `toolPolicy: dsh-owned`; it does not require a duplicate `workspaceRoot`. The active DSH Session and ToolRuntime control the project, read/write, shell, network, MCP, and approval behavior.

### Agent preset configuration

Read-only:

~~~yaml
agentPreset: read-only
~~~

Workspace write:

~~~yaml
agentPreset: workspace-write
workspaceRoot: C:\work\my-project
~~~

Write access is enabled only when the explicit preset, workspace, and Agent whitelist all pass validation.

### Configuration example

~~~yaml
enabled: true
provider: agy
agent: deepseek-proxy
model: gemini-3.7-flash-high
models:
  - id: gemini-3.7-flash-high
    name: Gemini 3.7 Flash High
toolPolicy: dsh-owned
sessionMode: full
modelDiscovery: auto
retryPolicy:
  maxRetries: 0
  retryableCodes: [RATE_LIMIT, SERVER, TRANSPORT]
imageInput: off
~~~

Retries are disabled by default so one DSH request cannot silently multiply AGY quota usage. Explicit opt-in remains bounded by a maximum count and an error-code allowlist.

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

Experiments that call a real AGY model never run automatically. The image experiment has an independent quota gate and should not be repeated without explicit authorization.

## Roadmap

Future work follows the same rules: verifiable behavior, safe fallback, and bounded quota use.

### 0.7.0: DSH-controlled workspace, permissions, and tools (in development)

- The base DSH-owned tool bridge is implemented: AGY emits locally validated DSH tool calls, while DSH ToolRuntime executes filesystem, shell, network, and MCP tools.
- The V7-M4 permission matrix and cross-platform CI are complete; V7-M5 is hardening doctor v3, allowlisted telemetry, protocol limits, prototype-pollution/Unicode checks, symlink/junction handling, and temporary-file cleanup.
- Use the DSH Session project `cwd` and its `read-only`, `workspace-write`, or `danger-full-access` selection instead of duplicating switches in this plugin.
- Keep sandboxing, approval, MCP credentials, and side effects inside DSH; the Provider does not pass `--dangerously-skip-permissions`.
- See the [0.7.0 development plan](docs/v0.7.0-development-plan.md) for scope, security gates, quota budget, and milestones.

### Later: image and tool UX hardening

- Consider public image modality only after an end-to-end DSH Web AttachmentStore → AGY pixel-answer path is proven.
- Improve workspace-write conflict handling, backup, rollback, and tool-call presentation.
- Never bypass the DSH session permission preset merely because a write tool exists in the catalog.

### Later: transport and cost optimization

- Consider persistent transport only after real AGY protocol, isolation, crash recovery, process cleanup, and token-cost gates prove a benefit.
- Continue purpose-aware compaction/session-title routing and usage observability.
- Keep CI, doctor, parser, and Mock smoke quota-free.

## Explicit non-goals

- Calling the Gemini API directly or managing OAuth/refresh tokens inside the plugin.
- A dual DSH/AGY tool-execution loop.
- Unverified glob, shell, network, MCP, subagent, or automatic permission approval capabilities.
- Default writes to a user's workspace.
- Public image modality, temperature, stop, maxTokens, or unverified reasoning-delta output.
- Production persistent stream transport before cost and reliability evidence exists.

## Project structure

~~~text
dsh-agy-provider/
├─ src/
│  ├─ provider/       # DSH Adapter, config, serialization, image bridge
│  ├─ agy/            # process, argv, stream-json, discovery, redaction
│  ├─ session/        # DSH Session to AGY Conversation mapping
│  ├─ doctor.ts       # profile-aware doctor v3
│  └─ agent-*.ts      # presets, installer, and agents CLI
├─ agents/            # tool-free/read-only/workspace-write templates
├─ scripts/           # verify, benchmark, diagnose, and DSH smoke
├─ tests/
├─ docs/
├─ cordis.patch.yml
└─ package.json
~~~

## Documentation

- [Installation](docs/installation.md)
- [0.6.0 migration guide](docs/migration-0.6.0.md)
- [Tool capability matrix](docs/tool-capability-matrix.md)
- [Compatibility matrix](docs/compatibility-matrix.md)
- [Release checklist](docs/release-checklist.md)
- [CHANGELOG](CHANGELOG.md)
- [0.7.0 development plan](docs/v0.7.0-development-plan.md)
- [0.6.0 development plan](docs/v0.6.0-development-plan.md)
- [DSH Provider contract](docs/dsh-provider-contract.md)
- [Performance baseline](docs/performance-baseline.md)

## License

MIT
