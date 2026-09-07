# Second opinion: `pi-conductor-prewalk-continuation-spec.md`

**Status:** Review / findings. Not a plan of record.
**Reviews:** `docs/pi-conductor-prewalk-continuation-spec.md` (Proposed MVP)
**Repo state:** `d39c488` (post-v0.20.1), pi SDK `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai` as installed in `node_modules/`
**Companion artifact:** `docs/pi-conductor-prewalk-projection-spec.md` (alternative design)

---

## 0. Answer to the question asked

> Isn't the context/reasoning from specific vendors opaque and could pose a challenge for this enhancement anyways?

**Yes — vendor reasoning is genuinely non-transferable, and R2's wording is false as written. But the reasoning is not what carries the handoff, so this is a correctable defect in the spec's claims, not a defect in the idea.**

The spec's load-bearing requirement is R2:

> The executor's first provider request must include the guide's prior user messages, assistant messages, tool calls, tool results, checklist checkpoint, and first edit trajectory.
> Do not serialize that history into Markdown, a handoff payload, or a new user message.

That is not literally what happens. The SDK rewrites history per target model on every request. From
`node_modules/@earendil-works/pi-ai/dist/api/transform-messages.js`, `transformMessages()`:

```js
const isSameModel = assistantMsg.provider === model.provider &&
    assistantMsg.api === model.api &&
    assistantMsg.model === model.id;
```

Everything downstream keys off that flag. Cross-model — which is the entire point of Prewalk — the following happens to the guide's history before the executor ever sees it.

### 0.1 What is lost


| Guide content | Cross-model outcome |
| --- | --- |
| `thinking` with `redacted: true` (opaque encrypted payload) | **dropped** (`return isSameModel ? block : []`) |
| `thinking` with `thinkingSignature` and empty text (OpenAI Responses encrypted reasoning) | **dropped** (`if (!block.thinking \|\| block.thinking.trim() === "") return []`) |
| `thinking` with visible text | **downgraded to a plain `text` block**, signature stripped |
| `toolCall.thoughtSignature` (Gemini) | **`delete`d** |
| `toolCall.id` | **renormalized** when the target requires it (Anthropic's `^[a-zA-Z0-9_-]+$`, ≤64 chars) |
| assistant message with `stopReason: "error" \| "aborted"` | **skipped entirely** — the whole message vanishes |
| tool call with no matching result | **synthetic `toolResult`** `"No result provided"`, `isError: true` |

Note that `isSameModel` requires provider **and** api **and** `model.id`, so same-vendor-different-model loses signatures too. There is no cross-model configuration in which vendor reasoning survives. Your premise is correct and it is unfixable at this layer.

### 0.2 What is preserved — and it is almost everything that matters

The same function, cross-model:

```js
if (msg.role === "user") return msg;                       // unchanged
if (msg.role === "toolResult") { /* id remap only */ }      // content untouched
if (block.type === "text")
    return isSameModel ? block : { type: "text", text: block.text };   // verbatim
if (block.type === "toolCall") { /* strip thoughtSignature, renormalize id */
    return normalizedToolCall; }                            // name + arguments intact
```

So cross-model, the executor inherits **verbatim**: every user message, every word of the guide's visible prose, every tool call with its full arguments, and every tool result — meaning every file the guide read, every grep result, every diff it applied, and the entire `execution_checkpoint` checklist. Tool-call IDs are remapped consistently through `toolCallIdMap`, and `toolResult.toolCallId` is remapped to match, so pairing is maintained.

What is lost is the guide's private reasoning. That is:

- **the vendor-opaque part**, which by construction can never be portable — signed/encrypted reasoning is provider continuation state, not a memory substrate; and
- **the part you would not want to transfer anyway** — reasoning is where abandoned hypotheses, discarded approaches, and self-corrections live.

So the honest statement of the mechanism is: **`transformMessages()` is a reasoning-stripping transform that preserves the observable working record.** For a guide→executor hand-down, that is close to the transform you would have written by hand. My earlier framing — that this is "a lossy projection delegated to an SDK internal" — over-weighted the reasoning loss. The substance is not projected; it is copied.

R2's wording is still wrong and should be fixed, because a spec that claims exactness it does not have will mislead whoever debugs it later. But the correct fix is to state the transform's contract explicitly, not to abandon native continuation.

### 0.3 The residual cross-model hazards are structural, not semantic

These are the things that can actually break the executor's first request, and each is mechanical and testable offline:

1. **Empty-content assistant messages.** An assistant turn whose content was *only* an encrypted-reasoning block (OpenAI Responses) collapses to `content: []`. Several providers reject an empty assistant message.
2. **Synthetic error results.** An unresolved tool call becomes `"No result provided"` with `isError: true`. If the `execution_checkpoint` result is not durably appended before `terminate: true` stops the turn, the executor's first inherited observation is a *failed* checkpoint (§1.7).
3. **Dropped errored turns.** A `stopReason: "error"` assistant message vanishes with its tool calls, which can leave adjacent results orphaned.
4. **Local chat-template fragility.** A restrictive llama.cpp / vLLM / MLX template may reject a frontier-authored multi-tool-call transcript, or historical calls to tools not in the current declaration.
5. **Reasoning-as-assertion.** Visible thinking becomes a plain first-person `text` block, so the guide's *abandoned* hypotheses read as flat claims the executor authored. This is the one semantic hazard, and it is real (§2.2).

Every one of 1–4 is decidable **before** the switch, because `transformMessages` is exported from `@earendil-works/pi-ai/api/transform-messages` and the host can run it as a preflight against the executor's model resolution and inspect the output. That preflight — not a same-model restriction — is the right guard.

### 0.4 Also worth naming

**The transform is per-request and does not mutate stored history.** The session JSONL keeps the guide's signed reasoning the executor never received. Anyone reading the transcript for post-hoc diagnosis — the spec's own "Transcript UI" expansion — reads a conversation that never existed for the executor. Fix by rendering the transformed view or labelling the difference; the host can reproduce it exactly with the same exported function.

---

## 1. Verified mechanical defects

These are not judgement calls. Each is a code fact in this repo or in the installed SDK.

### 1.1 The admission math measures the wrong token set on the wrong tokenizer

`src/host/trajectory-admission.ts:124`:

```ts
const required = args.source.tokens + roleEnvelopeTokens + targetModel.maxTokens + 8192;
```

`args.source.tokens` comes from `RoleSession.getTrajectoryContext()` → `session.getContextUsage()?.tokens` (`src/host/role-session.ts:61`). In the SDK, that resolves through `estimateContextTokens()` →

```js
export function calculateContextTokens(usage) {
    return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}
```

…on **the last assistant usage**, i.e. the *guide's* provider-reported accounting of the *guide's* request, on the *guide's* tokenizer. Three separate errors follow:

- It is the wrong tokenizer. Anthropic, OpenAI, Gemini and a local Qwen GGUF disagree materially on dense code and JSON tool results.
- It is the wrong token set. It is computed **pre-transform**. Thinking that will be dropped is counted; thinking that will be downgraded to text is counted at its thinking length; synthetic `"No result provided"` results are not counted.
- The fallback path (`input + output + cacheRead + cacheWrite`) is not a context size at all — for providers where `cacheRead` is a subset of `input`, it double-counts, and `output` is not in the next request's prefix at all except as the last assistant message.

Trailing messages fall back to `estimateTokens`, documented in the SDK as `chars/4` and "conservative (overestimates tokens)". A `chars/4` heuristic is not strong enough to underwrite a hard fail-closed gate: it produces both false rejects (killing the run *after* frontier spend) and false accepts (a provider 400 or a silent truncation by a local llama.cpp/vLLM server at the worst possible moment).

### 1.2 The `maxTokens` reservation makes small local executors structurally inadmissible

`required` reserves the target's **full** `maxTokens` plus 8192. For the spec's own example executor (`omlx:Qwen3.8-27B-oQ4e-mtp`), a 32k-context local model with an 8k–32k `maxTokens` declaration leaves between ~16k and *negative* room for the guide's transcript. A frontier guide that greps a repo and reads five files clears 16k easily.

The spec's chosen headline use case is therefore the case most likely to fail admission — and to fail it *after* the frontier tokens are spent and the working tree has been modified. That is not fail-closed in any useful sense; it is fail-expensive.

### 1.3 Cost roll-up silently misattributes all guide spend to the executor model

`src/cost/rollup.ts:163`:

```ts
const modelKey = record.model ?? SYSTEM_DEFAULT_MODEL_KEY;
const modelAgg = perModel.get(modelKey) ?? ZERO_AGGREGATE;
perModel.set(modelKey, addUsage(modelAgg, usage));
```

`perModel` is keyed off the **terminal** lifecycle record's `model`, and usage is only aggregated from terminals (`session_ended` / `session_failed`). The spec then says:

> expose the currently active logical model through a getter so `session_started` identifies the guide and `session_ended` identifies the executor
> Do not create separate conductor role-session lifecycle records for the phases.

`session_started` carries no usage. So 100% of guide + executor usage lands under the **executor** model key. `perModel` — whose documented purpose is "reveals load split" — becomes actively misleading for exactly the feature whose entire justification is "the frontier model is only needed for one edit." The one number that would tell you whether Prewalk saves money is the one number the design breaks.

### 1.4 A single shared cap lets the guide eat the executor's budget

Assumption 6: "The role's existing `max_session_cost_usd` covers guide and executor usage together." `src/cost/caps.ts`:

```ts
export function sessionCapExceeded(invocationUsage: UsageAggregate, cap: number): boolean {
  return invocationUsage.cost >= cap;
}
```

A hard `>=` stop on the shared total. A verbose frontier guide can approach the cap during exploration; the cap then trips on an early executor turn and `src/host/tools.ts` refuses the write via the abort-signal path. Result: full frontier spend, a half-applied exemplar edit, `session_failed`, zero delivered work. There is no guide-phase sub-cap in the design.

The inverse is worse for the stated local-executor use case: a local executor costs ≈ $0, so after the switch the cost cap stops being a safety valve entirely. A stuck local model grinds indefinitely for free. There is no turn cap or wall-clock cap in the spec.

### 1.5 Prompt caching is destroyed at the switch, and the cost model does not account for it

The switch changes the model *and* the system prompt (overlay removal) *and* the tool definitions. Each alone invalidates provider-side prefix caching; a model change is a separate cache namespace regardless. So:

- Every cache-write token the guide paid for during exploration is thrown away.
- The executor's first request is a **full cold prefill of the entire guide transcript** at uncached input price.
- Break-even is driven by the number of *post-switch* turns, not by history size, because the cold prefill is a fixed upfront cost. Short executions lose money outright.

The spec's experiment does measure "guide and executor input/output/cache tokens" and "switch prefill time and executor TTFT" — good — but there is no break-even formula and no gate on predicted executor turn count. And there is a latency dimension the spec under-weights: prefilling tens of thousands of tokens on local hardware is seconds to minutes of dead time *per turn* unless the local server's KV prefix cache survives, which requires the prefix to stay byte-stable after the switch.

### 1.6 A role with `models[]` fallbacks gets a different history per fallback

`transformMessages()` is applied per request against the *actual* target model. If the executor role declares fallbacks (§8.2), each fallback sees a differently-transformed history and pays another cold prefill. The spec neither forbids fallbacks under `prewalk` nor accounts for them. `admitTrajectory` is called once, for one target model.

### 1.7 The `execution_checkpoint` `terminate: true` path is not obviously safe

`src/host/tools.ts` uses `terminate: true` only on results that also end the conductor session, and the seam machinery is built around that coupling. The spec wants `terminate: true` to end *only the native turn* while leaving the outer conductor prompt open, with the tool result sealed into history first. Two things need proving, not asserting:

- the checkpoint tool result is durably appended before the turn stops, or the executor inherits an orphaned `toolCall` and `transformMessages()` synthesizes `"No result provided"` with `isError: true` as the executor's first inherited observation;
- `activeSeam()` is genuinely untouched, so `validateEmission` at the loop still reads an empty buffer.

### 1.8 Dangling tool history vs. the reduced allowlist

R5 restores the normal allowlist for the executor, so the inherited history contains an `execution_checkpoint` tool call for a tool the executor cannot call. Two distinct risks:

- **Protocol:** whether every target — including a local OpenAI-compatible server with a restrictive chat template — accepts historical calls to undeclared tools. Unknown until fuzzed.
- **Behavioral:** models imitate tool calls they see in their own history, and typically retry an unavailable tool several times before giving up. There is no deterministic rejection path or loop breaker in the design.

The cheap mitigation is to keep `execution_checkpoint` **registered but inert** for the executor, returning a stable corrective result, rather than removing it.

---

## 2. Design-level objections

### 2.1 The switch mutates the three things the manifest pins, with no reducer event

`AGENTS.md` invariants 2 and 4: role set and caps come only from the pinned `MachineDefinition`; every state change goes through `reduce`. Prewalk changes the active model, the system prompt, and the tool allowlist mid-visit with no `reduce` call, no checkpoint snapshot, and no cost-cap re-evaluation against a new price basis — and R1 explicitly forbids any observable transition.

I do not think this is fatal, but it should be a recorded decision rather than a silent consequence. The project's reason to exist is *guarded, observable* handoffs; this is an unguarded, deliberately-unobservable one. At minimum the phase must be a persisted host substate (it partly is, via `prewalk_switch_selected`) **and** resume must restore the phase's model/effort/prompt/tools, or a resume will silently revert to the guide and re-run execution at frontier prices.

Relatedly, the resume story in the spec covers only the narrow window between `prewalk_switch_selected` and `prewalk_executor_seed_delivered`. It does not cover: a crash *during* the guide phase after the exemplar edit landed (the tree is dirty, no record exists), or a resume that must know which phase's environment to re-apply. There is no git checkpoint of the exemplar edit anywhere in the design, so an admission failure leaves an uncommitted partial change with no rollback and, per the failure policy, no fresh executor to finish it.

### 2.2 Impersonation is the wrong objective

R3 wants the executor to have no idea a different model did the prior work. The spec frames this as the key insight. I think it is the design's biggest behavioral liability.

The most common real failure mode for a weak model resuming a strong model's transcript is not confusion — it is **silent capability collapse with preserved style**: the executor pattern-matches the guide's confident register, marks TODOs done without running the validation, and produces output that *looks* like the guide's work. That defeats review, which is the expensive kind of failure. Impersonation optimizes for the executor not noticing that it is weaker than the author of its own history.

Secondary effects of the same choice:

- **Dangling instructions.** Removing the overlay removes the *authority* for constraints whose *effects* remain visible in history. The executor can see that the guide bounded its scope; it cannot know the rule or its priority. Any invariant that must hold has to be restated where the executor can see it.
- **Downgraded reasoning reads as commitment.** Cross-model, visible thinking becomes a plain first-person `text` block. The guide's *abandoned* hypotheses now read as flat assertions the executor authored. Models demonstrably resume discarded plans presented this way. Corollary: the checklist must never live in thinking — which the spec gets right by using a tool call, but it does not forbid the guide from reasoning out loud about alternatives.
- **Overlay leakage.** Nothing stops the guide's own assistant text from restating the overlay ("I won't hand off in this phase", "I'll stop here for now"). The executor inherits that as its own prior turn — plausibly re-creating the premature-ending behavior the feature exists to fix. Not covered by any acceptance criterion.
- **Reverse contamination.** If the executor's output is ever followed by another guide turn (an escalation path the spec doesn't have but will want), the guide then reasons over weaker-model text presented as its own work.

An explicit-provenance prompt is less elegant and more robust: *a guide model did the preceding exploration and initial edit; treat its checklist and edit as prior work to verify, not as truth; these are the tools you have now; find the first incomplete item.*

### 2.3 The value proposition is inverted relative to where it is pitched

The spec's example executor is a local model, and the local case is where inherited native history is *most* expensive: cold prefill on consumer hardware, effective-context degradation well below the nominal window (a "32k" local model is often unreliable past 8–12k of dense code), chat-template fragility for frontier-authored multi-tool-call transcripts, and — per §1.2 — near-certain admission failure. The claimed benefit is largest exactly where the mechanism is weakest.

### 2.4 Unhandled and under-justified cases

- **A guide that finishes the task has no legal exit.** R4 requires the checkpoint to be called with at least one incomplete TODO, and R5 disables `handoff`/`end` during the guide phase. A competent frontier model on a small task will complete it and then be unable to say so.
- **No circuit breaker.** If the guide ignores the overlay and works through the checklist, the design's only response is the shared cost cap. There is no turn cap and no auto-intercept at first mutation. Assumption 5 explicitly defers interception, which means MVP correctness rests on prose compliance by the guide.
- **The forced single exemplar edit is asserted, not tested.** It may induce the right pattern; it may also anchor the executor to a premature implementation, and it will be cargo-culted into cases where it does not apply. Its value should be established by ablation (plan-only vs. plan+exemplar), and if it does help, two or three exemplars covering the variation would help more.
- **Prewalk on every visit** (assumption 4) means re-paying frontier exploration up to `max_visits` times, on a session that already contains the previous visit's conclusions.
- **Stub-provider acceptance tests are structurally blind to the failure this review is about.** A stub provider emits no signed or redacted thinking, so every transform-loss path in §0 is unexercised. The acceptance criterion "a provider-backed test proves that the executor sees the guide's exact read/tool/edit history" will pass against a stub while being false against every real provider pair.

### 2.5 Smaller notes

- **Prompt-injection asymmetry.** Repository text, logs and tool output are untrusted. The guide can elevate injected text into authoritative-looking assistant messages, and the weaker executor is more likely to obey it. Executor tools should stay minimally privileged and its prompt should declare prior assistant content and TODOs as working material, not instructions.
- **"No compaction" must be enforced, not inferred.** `src/host/trajectory-settings.ts` already does this for trajectories and asserts the result; Prewalk must reuse it rather than rely on `getContextUsage()` behavior. Note that `admitTrajectory` already rejects any history containing a compaction entry, so a long guide phase that auto-compacts is unrecoverable — another reason to bound the guide forward rather than check it afterward.
- **Effort semantics.** `assertTrajectoryEffortSupported` is the right guard, but `setThinkingLevel` on a non-reasoning local executor and a reasoning-model → non-reasoning-model downgrade both silently remove the internal verification step the guide's plan implicitly assumed.
- **Session-file provenance.** After the switch, one JSONL contains messages authored by two models with no per-message provenance beyond the assistant message's own `provider`/`model` fields. That is actually recoverable from the transcript — worth stating as the mechanism for the future Transcript UI rather than relying on `prewalk_switch_selected` alone.
- **Terms of service.** Reusing one vendor's output inside another vendor's context is not model training and is low-risk, but it is worth one line in the spec rather than zero.

---

## 3. What I would keep

This is not a rejection of the goal. Several parts of the spec are good and should survive into any alternative:

- **Removing the orchestrator turn from the middle.** The intervening routing turn and the terminal-`handoff` text in history (`src/host/tools.ts:260`: *"the loop will end this session"*) are a real, concrete cause of premature endings. The acceptance criterion asserting that string's absence is the single sharpest test in the document.
- **One logical role visit, one FSM transition.** Correct. Guide/executor is a phase distinction, not a role distinction; adding worker→worker FSM edges to get this would be worse.
- **Fail-closed rather than compact-or-truncate.** Right instinct. The problem is *when* the check runs, not that it exists.
- **`execution_checkpoint` as a host control signal that never touches `SessionSeam` or `reduce`.** Exactly the right boundary, and consistent with invariant 6.
- **Persist-before-mutate, with an idempotent seed-delivery record.** The `prewalk_switch_selected` → apply → `prewalk_executor_seed_delivered` ordering is sound and should be kept verbatim.
- **Build step 1 — lock down the failure first.** The best step in the plan. Do not skip it; the premature-ending hypothesis may have a mundane cause that a much smaller fix addresses.

---

## 4. What I would change about how it is built

Full design in `docs/pi-conductor-prewalk-projection-spec.md`. The short version:

**Slice 0 — falsify offline, before any host integration.** Two harnesses, no API keys needed beyond capturing a handful of real guide transcripts:

1. **Transform conformance.** Take real guide transcripts, run `transformMessages()` toward every candidate executor (including your actual local server), and assert the output is a valid, renderable request. Specifically look for empty-content assistant messages, orphaned/synthetic `toolResult`s, dropped `stopReason: "error"` messages, and template rejections. *Kill criterion: an **unrepairable** provider rejection routes that pair to projection mode; a repairable one becomes a host preflight repair.*
2. **Tokenizer calibration.** `chars/4` and `getContextUsage()` vs. real per-model token counts on the same transcripts. *Kill criterion: p95 relative error above ~10–15% means fail-closed admission as specced is unshippable — and a safety margin large enough to fix it rejects most real runs.*

**Keep cross-model native continuation as the primary mode — it is the feature.** Restricting `native` to a same-model effort change, as an earlier draft of this review proposed, guts the value proposition: the point is to hand down from an expensive model to a cheap one, and the transform's preserved set (§0.2) is adequate for exactly that.

**Guard it with a preflight, not a capability restriction.** Before mutating anything, run the exported `transformMessages()` against the executor's model resolution and assert the result is a valid request: no empty-content assistant message, every tool call paired, no synthetic `isError` result, no dropped-turn orphan. Repair what is repairable (drop empty assistant messages, seal the checkpoint result first, elide dropped turns cleanly); fail before spend for what is not. This turns §0.3's hazards 1–4 from production surprises into a preflight decision.

**Add a projection mode as the fallback, not the default.** When the preflight cannot produce a valid request for a given executor — most likely a restrictive local chat template — the host builds the opening context deterministically from durable records: guide brief with **machine-executable** validation commands and allowed paths per item, the exemplar diff (already recorded with hunks in `src/persistence/file-mutation.ts`), and verbatim replay of still-valid tool results. This is also the mode to use when the guide transcript exceeds the executor's window, since it is bounded by construction.

**Fix the mechanical defects in §1 regardless of mode:** forward context budget enforced during the guide phase instead of a post-hoc veto; target-tokenizer-aware accounting with a calibrated margin; `min(maxTokens, reservation)` instead of the full output ceiling; split cost caps with a guide sub-cap; turn + wall-clock caps for the ≈$0 local executor; honest per-model attribution via phase records; a git checkpoint of the exemplar edit; host-run validation instead of self-attestation; explicit provenance instead of impersonation; a legal `already_complete` exit for the guide.

**The decisive experiment is not the one in the spec.** The spec compares Prewalk against a local one-shot and against the current trajectory chain. Beating a local one-shot proves only that a frontier model's plan helps. The comparisons that decide the design are:

> **native continuation vs. host-owned projection** — holding guide model, executor model, task, repo state, checklist, exemplar edit and validation constant. This isolates whether inheriting the verbatim working record beats a reconstructed brief. My prior now favours native: the retained tool results are the bulk of the value and native gets them for free, in the right positions, with correct tool-call pairing.
>
> **and native continuation vs. the frontier model alone** at comparable cost — the arm that decides whether the feature has an economic justification at all.

---

## 5. Summary judgement

| | |
| --- | --- |
| **Goal** | Sound and worth pursuing. |
| **Premise (R2: exact native history)** | **Overstated, not fatal.** Cross-model the SDK strips vendor reasoning, downgrades visible thinking to text, and discards errored turns — but preserves user messages, assistant prose, tool calls with arguments, and all tool results verbatim. The transform is effectively reasoning-stripping, which is close to the right transform for this hand-down. R2 must be reworded to state the contract; the mechanism stands. |
| **Admission (R8)** | Wrong tokenizer, wrong token set, computed pre-transform, gated after frontier spend, and structurally inadmissible for the spec's own local-executor example. |
| **Accounting** | `perModel` attributes all guide spend to the executor model (`src/cost/rollup.ts:163`); a single shared cap lets the guide starve the executor; cost caps are inert for a local executor with no turn cap. |
| **Impersonation (R3)** | The wrong objective. Optimizes for the executor not noticing it is weaker; invites false-done, dangling instructions, and overlay leakage. |
| **Verification plan** | Stub-provider tests cannot see any of the transform losses. The decisive comparison (native vs. projection) is missing. |
| **Residual cross-model risk** | Structural, not semantic, and decidable offline: empty-content assistant messages, synthetic `isError` results from an unsealed checkpoint, dropped errored turns, local chat-template rejection. Guard with a `transformMessages()` preflight before any mutation. |
| **Recommendation** | Do build step 1 (lock down the failure). Then run Slice 0 offline conformance + tokenizer calibration. Then ship **cross-model native continuation as the primary mode**, gated by a transform preflight, with projection as the fallback for executors the preflight rejects or transcripts that exceed the window. Fix the §1 defects and record the decision for the manifest-pinning invariant the swap bends. |
