# Models, APIs and execution configuration

[← README](../README.md)

TripleTeam separates **provider connection settings** from **per-project model selection**. You can use a different model, API host and credential for planning, implementation, exploration and review.

## 1. Where each setting lives

| File or environment | Purpose |
| --- | --- |
| Target repository `.tripleteam.json` | Global model defaults, role overrides, checks and shared budget |
| `~/.pi/agent/models.json` | Custom provider URL, API protocol, model catalog and credential references |
| Provider environment variables | Actual API keys, inherited by worker processes |
| `PI_CODING_AGENT_DIR` | Optional replacement for `~/.pi/agent`; inherited by all workers |

Pi owns API communication and authentication. TripleTeam applies each role's selection through public Pi settings and binds it to the run. No Pi chat interface needs to be opened.

## 2. Built-in providers

For built-in providers, configure the corresponding environment variable, then inspect the local catalog:

```bash
export ANTHROPIC_API_KEY='your-key'
export OPENAI_API_KEY='your-key'
tripleteam models anthropic --plain
tripleteam models openai --plain
```

You only need credentials for the providers you select. `models` reads registered model metadata without sending an inference request. `authConfigured` reports configuration presence; it does not make a paid connectivity probe.

Use returned provider/model IDs in `.tripleteam.json`. Reasoning values are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`; select a level supported by that model.

## 3. Give every role its own model

```json
{
  "execution": {
    "provider": "coding-api",
    "model": "YOUR_CODING_MODEL_ID",
    "reasoning": "medium",
    "roles": {
      "planner": { "provider": "reasoning-api", "model": "YOUR_REASONING_MODEL_ID", "reasoning": "high" },
      "explorer": { "provider": "coding-api", "model": "YOUR_FAST_MODEL_ID", "reasoning": "low" },
      "implementer": { "provider": "coding-api", "model": "YOUR_CODING_MODEL_ID", "reasoning": "medium" },
      "reviewer": { "provider": "review-api", "model": "YOUR_REVIEW_MODEL_ID", "reasoning": "high" }
    }
  }
}
```

| Role | Work | Model setting applies to |
| --- | --- | --- |
| `planner` | Plan dependencies and diagnose a revised approach | Initial planning and REPLAN |
| `explorer` | Read-only repository investigation | Planning investigations and diverse exploration |
| `implementer` | Write code in an isolated worktree | New attempts, retries and resumed writer executions |
| `reviewer` | Review immutable candidates | Independent candidate review |

If you refer to a “main agent”, the planner is the main planning model here. Scheduling and acceptance are deterministic services. Agents are instantiated as work requires them.

Precedence: **role override → global execution setting → selected Pi profile / Pi default**. A provider override must also specify its model. A model-only override inherits the global provider. Same-role parallel workers share the effective role settings. All roles share the run budget.

Inspect the effective selections before starting:

```bash
tripleteam profiles /path/to/target/repository
```

Profiles, project configuration and model choices are frozen for a run. Change configuration for a new run; restore the original configuration when continuing existing work.

## 4. Custom URLs and separate API keys

Copy the [provider template](../examples/models.example.json) into your user registry, or merge its `providers` entries into an existing registry. Replace the host names and model IDs with those provided by your service. Set context/output limits to the actual model limits.

```bash
mkdir -p ~/.pi/agent
# If models.json already exists, merge the providers instead of replacing it.
cp -n examples/models.example.json ~/.pi/agent/models.json
```

Example provider:

```json
{
  "providers": {
    "coding-api": {
      "baseUrl": "https://YOUR_CODING_HOST/v1",
      "api": "openai-completions",
      "apiKey": "$TRIPLETEAM_CODING_API_KEY",
      "authHeader": true,
      "models": [{ "id": "YOUR_CODING_MODEL_ID" }]
    }
  }
}
```

```bash
export TRIPLETEAM_REASONING_API_KEY='your-planning-provider-key'
export TRIPLETEAM_CODING_API_KEY='your-coding-provider-key'
export TRIPLETEAM_REVIEW_API_KEY='your-review-provider-key'
tripleteam models coding-api --plain
```

The keys can belong to different providers or accounts. They are read from the process environment; `.env` files are not loaded automatically. Configure the same environment when starting the daemon.

The registry uses **`$VARIABLE`** or **`${VARIABLE}`** for environment interpolation. A bare `VARIABLE` string is a literal, not a reference.

Supported registry protocols in the fixed runtime:

| `api` | Endpoint family |
| --- | --- |
| `openai-completions` | OpenAI-compatible Chat Completions, gateways and local servers |
| `openai-responses` | Responses API |
| `anthropic-messages` | Anthropic Messages API |
| `google-generative-ai` | Google Generative AI |

Use the protocol and base URL required by your provider. Complete registry options, headers and compatibility controls are documented in the [vendored runtime reference](../vendor/pi/pi-coding-agent/docs/models.md).

Then copy [the mixed-model project template](../examples/tripleteam.mixed-models.json) into the target repository as `.tripleteam.json` and replace all `YOUR_*` placeholders consistently. These example files contain no credentials.

## 5. Budgets and strategies

```json
{
  "execution": {
    "policy": "ADAPTIVE",
    "maxParallelism": 4,
    "maxExecutions": 64,
    "tokenLimit": 200000,
    "deadlineMs": 3600000,
    "maxFinalRepairs": 2,
    "decisionMode": "interactive"
  }
}
```

| Policy | Execution |
| --- | --- |
| `SINGLE` | One whole-goal writer task, shared retry budget |
| `FIXED` | Fixed parallelism cap, subject to compatibility gates |
| `HEURISTIC` | Conservative structure and coupling rules |
| `ADAPTIVE` | Runtime feedback and marginal-benefit estimates with the same safety gates |

Optional `costLimitUsd` uses reported provider prices. For custom models, first configure actual per-million-token `cost.input`, `cost.output`, `cost.cacheRead` and `cost.cacheWrite` in `models.json`; omitted pricing must not be treated as a measured free service. Token budgets work without a custom dollar price table. Requests already in flight can finish after a budget boundary.

`decisionMode: "noninteractive"` disables human answers, messages and manual retry decisions for autonomous evaluation. Use the [benchmark protocol](BASELINE_COMPARISON.md) for comparisons.

## 6. Checks and delivery

Define `candidateChecks`, `integrationChecks`, `runChecks` and `reviewRequiredFor` alongside `execution`. Full examples: [verification guide](VERIFICATION.md). Commands receive independent check worktrees, so prepare dependencies in the check environment or in the pinned container image.
