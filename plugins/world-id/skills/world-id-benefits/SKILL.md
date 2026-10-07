---
name: world-id-benefits
description: Find benefits, discounts, trials, and access published through World's production MCP catalog. Use when the user asks what World ID unlocks or whether a service has a World ID benefit.
---

# Official World ID benefits

Use only the bundled `world-id-hub` MCP connection.

1. Call `get_world_id_hub` before answering any request about current World ID benefits.
2. Present only benefits returned by that live catalog, including the provider's description and application URL when supplied.
3. Do not merge in native experiments, unpublished offers, another environment, or web-search results as if they were official catalog entries.
4. A listing is not proof of eligibility or redemption. Explain that the provider completes any remaining sign-in, eligibility, or claim step. `connection_state` describes only the separate provider connection.
5. If the official catalog is empty or unavailable, say so plainly and do not invent or substitute offers.

Never expose or request World ID proofs, tokens, subjects, continuity handles, nullifiers, wallets, biometric data, or other private identifiers.
