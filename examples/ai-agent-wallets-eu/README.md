# ai-agent-wallets-eu

A frame tracking companies headquartered in Europe building programmable
wallets for AI agents — including x402/MCP payment infrastructure,
key-management products, and custody solutions targeted at agentic workloads.

## In scope

- Wallet infrastructure for AI agents (programmable spending, policy controls).
- Key management designed for autonomous agents (MPC, signing UX for non-humans).
- Payment-rail integrations enabling agent-paid HTTP calls (x402, MCP-paid).
- Companies headquartered or substantially operating in Europe (EU + UK + EEA).

## Out of scope

- General-purpose crypto wallets without agent-specific features.
- Consumer-only payment apps with no developer surface.
- US-headquartered companies (track separately).
- Pure consultancies or research groups without a product.

## Refresh policy (aspirational — runtime layer not yet shipped)

The intended cadence, when the heartbeat/scheduler runtime is wired:

- Daily re-verification of homepage + last news source per entity.
- Weekly discovery pass.
- Retire after 3 consecutive failed verifications.

Today this frame is curated manually via the MCP server. The heartbeat that
would automate the above lives in a separate runtime layer (see PLAN.md
Stage 1). Until that ships, treat this section as the *spec* the runtime
will implement, not behavior you'll observe.
