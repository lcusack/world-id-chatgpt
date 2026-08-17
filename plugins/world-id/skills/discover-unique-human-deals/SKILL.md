---
name: discover-unique-human-deals
description: Discover current Human Required deals for unique humans through World ID. Use when a user launches the World ID plugin, asks what World ID or verified-human status unlocks, wants today's unique-human deals, asks about the Unique Human of SF discount or Cyto Liftoff sneaker, or wants prices, sizes, availability, or a link to claim an offer.
---

# Discover Unique-Human Deals

Turn the user's World ID connection into a concise, useful view of what unique humans can unlock at Human Required today.

## Start with current deals

1. Call `list_unique_human_deals` immediately when the user opens this experience or asks what verified humans can unlock.
2. Present only deals returned by the tool. Lead with the benefit, current availability, and eligible in-stock product count.
3. Mention that pricing and inventory were checked live.
4. Invite the user to choose a deal for product details, but do not require them to know a tool name or paste another prompt.

Every request that mentions today, current offers, availability, inventory, prices, sizes, or trying again requires a fresh tool call during that same turn. Never reuse a catalog result from an earlier message, even if it is still visible in the conversation.

If `list_unique_human_deals` is not available in the connector's tool catalog, call `get_world_id_status` instead. Its text response contains a live deal summary for compatibility with older connector snapshots. Call it afresh on every current-deals request. Do not report that the catalog is unavailable unless a tool call made in the current turn actually returned an error. If no relevant World ID tool can be called, explain that the connector needs to be refreshed rather than claiming the store is down.

Do not invent promotions, eligibility rules, inventory, prices, or expiration dates. If a fresh live catalog call fails, say so briefly and offer to retry.

## Inspect one offer

When the user chooses a deal or asks about its products, prices, sizes, or availability, make a fresh `get_unique_human_deal` call with the exact deal ID returned by `list_unique_human_deals`.

If `get_unique_human_deal` is not available, use a fresh `get_world_id_status` call for the current deal summary. Be transparent that detailed product and size data requires the refreshed connector tool; do not fabricate it from an older response.

Summarize the most useful in-stock options first. Include direct product or store links returned by the tool. Clearly label sold-out products or unavailable options instead of implying they can be purchased.

There is intentionally no broad product-search workflow in this version. Keep the experience focused on the current unique-human deals returned by the MCP server.

## Explain the store handoff accurately

The ChatGPT connection proves the account is linked to an Orb-verified World ID session. Human Required is a separate service and performs its own World ID check when the user claims a discount or gated product.

Never claim that opening a link automatically applies a discount, reserves inventory, creates a cart, or transfers the user's World ID proof to Shopify. Say that the user will complete the eligibility step on Human Required.

## Preserve privacy

Never request, display, or expose a World ID proof, World session ID, subject ID, nullifier, wallet, phone number, OAuth token, or biometric data.
