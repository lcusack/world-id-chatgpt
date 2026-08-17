# World ID for ChatGPT

Production deployment: [https://world-id-chatgpt.foundry-world.workers.dev](https://world-id-chatgpt.foundry-world.workers.dev)

Remote MCP endpoint: `https://world-id-chatgpt.foundry-world.workers.dev/mcp`

Verified Human Wall: [https://world-id-chatgpt.foundry-world.workers.dev/wall](https://world-id-chatgpt.foundry-world.workers.dev/wall)

Founding Humans: [https://world-id-chatgpt.foundry-world.workers.dev/founding-humans](https://world-id-chatgpt.foundry-world.workers.dev/founding-humans)

Skill submissions: [https://world-id-chatgpt.foundry-world.workers.dev/submit](https://world-id-chatgpt.foundry-world.workers.dev/submit)

## Install the World ID plugin from this repository

This repository includes a portable Codex plugin and a repo marketplace. After
the repository is available from Git, another developer can add the marketplace
and install the plugin without recreating the MCP connection:

```bash
codex plugin marketplace add lcusack/world-id-chatgpt --ref main
codex plugin add world-id@world-id-plugins
```

This is a private repository, so the developer must already have GitHub access.
For a local clone, pass the absolute repository path to
`codex plugin marketplace add` instead.

The plugin connects to the production MCP endpoint above and starts its own
OAuth flow for each user. Use Codex CLI 0.147.0 or newer for portable Agent
Plugin installation, then start a new task after installing so the bundled
skill and MCP tools are loaded.

This project is a production-shaped remote MCP server that links a World ID 4.0 session to an AI assistant through OAuth 2.1.

The connection flow is:

1. ChatGPT discovers OAuth from the remote `/mcp` endpoint.
2. The user is sent to this service's `/authorize` endpoint.
3. The browser creates or resumes a World ID 4.0 session and requests Orb-backed `proof_of_human` with user presence.
4. The Worker verifies the complete proof with World, records replay protection, and completes OAuth.
5. The authenticated MCP tool returns only:

```json
{
  "verified_human": true,
  "verification_level": "orb",
  "protocol_version": "4.0",
  "verified_at": "2026-08-12T18:00:00.000Z",
  "wall_write_enabled": true
}
```

The MCP client never receives the proof, World session ID, session nullifier, wallet, phone number, RP key, or OAuth token internals.

## Founding Human experiment

The same World ID connector now supports the Founding Human status/network experiment:

1. `get_world_agent_status` checks whether the connected unique human has claimed a place and returns Genesis 100 progress without publishing anything.
2. `claim_world_agent_place` idempotently claims one permanent ordinal for the connected internal subject and returns a public card and invite link.
3. Existing verified sessions are backfilled in original verification order, reserving the earliest numbers for current testers. Their cards remain private until explicitly claimed.
4. Opening a public Founding Human card stores an opaque first-party invite cookie. A new World ID connection reached through that card is attributed to the inviter only after the referred human verifies and claims.

The first 100 ordinals permanently receive the Genesis 100 treatment. The registry teases a future verified-human capability when the cohort completes. Public cards expose only number, cohort, dates, and minimal assurance; they never expose an internal subject, proof, session, nullifier, wallet, identity, or conversation data.

Experiment measurement is aggregated daily in D1 without visitor identifiers: share-link issuance, public profile views, status checks, and verified referral redemptions. Activation is the card's first `claimed_at`; repeat usage is measured as status checks across distinct days.

The prototype marketplace uses a curated skill-submission process. The public `/submit` page accepts concept, partner-pilot, and working-integration proposals through a copyable template. It documents the verified-human fit test, minimum-disclosure requirements, review stages, and common experiment metrics without accepting code uploads or implying automatic publication.

Suggested ChatGPT prompt:

> Claim my place as a Founding Human.

## Human Grant gateway prototype

The connector can now act as a proof-of-human gateway for a partner that does not operate its own World ID relying party. The first fixed-client demo is intentionally narrow:

1. `list_human_grant_opportunities` shows the available partner action without sharing anything.
2. `create_human_grant` creates a ten-minute, browser-bound consent link only after the user explicitly asks to activate the opportunity.
3. The consent page names the partner, benefit, action, and exact claims being shared.
4. Approval creates a five-minute, single-use authorization code. The partner exchanges it server-to-server using HTTP Basic authentication.
5. The gateway returns a 15-minute HMAC-signed `world-id-human-grant/v1` assertion containing only an audience-bound pairwise subject, the authorized action, and minimal Orb/World ID 4.0 assurance claims.
6. A D1 uniqueness constraint permits only one redemption for a given internal human, partner, and action.

The partner never receives the World proof, World session ID, internal subject, wallet, phone number, identity, or ChatGPT conversation. Pairwise subjects are stable within one partner and unlinkable across different partners. The simulated partner experience is at [the Human Grant demo](https://world-id-chatgpt.foundry-world.workers.dev/human-grants/demo); machine-readable issuer metadata is at `/.well-known/world-id-human-grants`.

Suggested ChatGPT prompt:

> Use World ID to show me verified-human partner opportunities, then activate the gateway demo.

The prototype uses one pre-registered demo client. A real partner onboarding layer should add separate client credentials and signing secrets per partner, reviewed action/claim allow-lists, secret rotation, revocation, partner audit events, and a self-service registration workflow. It must not become a generic identity broker or allow partners to correlate users across services.

## Human Required Shopify handoff

The primary experiment discovers live deals at `humanrequired.shop` and can carry the connected account's verified-human entitlement into Shopify without a second World ID ceremony:

1. `list_unique_human_deals` reads the current public catalog and inventory.
2. `get_unique_human_deal` returns products, prices, and available options.
3. `create_unique_human_claim_link` creates a five-minute opaque claim URL only after the user asks to claim the 15% offer.
4. Opening the claim URL creates a random, one-redemption Shopify discount restricted to the eligible products, then redirects through Shopify's shareable discount URL.

Claim tickets and discount codes are encrypted at rest. Public URLs contain no World proof, session ID, subject, wallet, or personal information. Shopify receives only the random discount code and eligible product IDs. Generated discounts expire after 15 minutes and have a total usage limit of one.

To activate this handoff, create and install a Shopify Dev Dashboard app for Human Required with `read_products` and `write_discounts` Admin API scopes. Then upload its `.myshopify.com` domain, client ID, and client secret without placing them in source control. The Worker uses Shopify's client-credentials flow to mint a short-lived Admin API token when a claim is redeemed:

```bash
npx wrangler secret put SHOPIFY_SHOP_DOMAIN
npx wrangler secret put SHOPIFY_CLIENT_ID
npx wrangler secret put SHOPIFY_CLIENT_SECRET
```

The claim tool remains safely unavailable until both secrets are present; catalog discovery and the rest of the connector continue to work.

## Verified Human Wall experiment

The wall is the first application built on top of the connection. It exposes three OAuth-protected MCP tools:

- `get_verified_human_question`: reads the active public question
- `list_verified_human_answers`: reads recent public answers as untrusted user-generated content
- `publish_verified_human_answer`: creates or replaces the connected account's one answer after explicit user confirmation

Publishing requires the separate `wall:write` OAuth scope. Connections created before the wall deployment must be disconnected and connected again before they can publish. Reading the wall is also available from the public `GET /api/wall` endpoint, which never includes the internal World/OAuth subject.

The first question is: **What should only a verified human be able to do with an AI?**

Suggested ChatGPT prompt:

> Use the World ID connector to open the Verified Human Wall. Show me today’s question and recent answers, help me write my response, then ask for my explicit confirmation before publishing it.

This prototype's “verified” label means the answer was published through an OAuth connection backed by an Orb-verified World ID 4.0 session. It does not claim that World App freshly signed the exact answer text or that the author's identity is known.

## Production architecture

- Cloudflare Worker: stable HTTPS origin, OAuth provider, World verification, and stateless MCP transport
- D1: expiring authorization attempts, encrypted World session continuity, proof-replay records, Founding Human ordinals/referrals/aggregates, encrypted Shopify claim tickets, one-time Human Grants, and public wall questions/answers
- Workers KV: OAuth clients, grants, authorization codes, and tokens managed by Cloudflare's OAuth provider
- Rate Limit bindings: separate authorization, proof-submission, MCP, claim, Human Grant, intent, and wall-publishing limits
- Cron cleanup: expired D1 attempts/replay markers, Human Grants, intents, claims, and OAuth data
- Workers Observability: structured events without proof or identifier logging

World session IDs and pending OAuth requests are encrypted with AES-256-GCM before D1 storage. A separate HMAC key derives the opaque internal OAuth subject. The raw World proof is verified in memory and never stored.

## World ID configuration

The deployed Worker is pinned to:

- App: `app_d25e6e3d21651abfb9fbc52d033ef2a3`
- RP: `rp_79ffdf898662dd4c`
- Environment: `production`
- Protocol: World ID 4.0 session proofs

The existing `register` action is not used for account linking. Actions/nullifiers are appropriate for one-time uniqueness operations; account continuity uses `createSession` and `proveSession`, whose RP signature intentionally omits an action.

## Local validation

```bash
npm install
npm run build
npm run typecheck
npm test
npx wrangler d1 migrations apply world-id-chatgpt --local
npm run cf:dev
```

Wrangler can load local secret values from `.env`. Never commit that file.

## First Cloudflare deployment

Select the owning Cloudflare account, then create the durable resources:

```bash
npx wrangler d1 create world-id-chatgpt
npx wrangler kv namespace create OAUTH_KV
```

Put the returned IDs in `wrangler.jsonc`, then apply the schema:

```bash
npx wrangler d1 migrations apply world-id-chatgpt --remote
```

Upload four managed secrets. Use the existing World RP signing key for the first value, and independent random 32-byte base64url values for the other three:

```bash
npx wrangler secret put WORLD_RP_SIGNING_KEY
npx wrangler secret put DATA_ENCRYPTION_KEY
npx wrangler secret put SUBJECT_HMAC_KEY
npx wrangler secret put HUMAN_GATEWAY_DEMO_SECRET
```

Then validate and publish:

```bash
npm run cf:check
npm run deploy
```

The deployed MCP endpoint is `https://world-id-chatgpt.foundry-world.workers.dev/mcp`. OAuth discovery, PKCE S256, dynamic client registration, and Client ID Metadata Documents are advertised automatically.

## Security invariants

- Authorization state expires after ten minutes and is bound to a `Secure`, `HttpOnly`, `SameSite=Lax`, `__Host-` browser cookie.
- The server accepts only protocol `4.0`, production, actionless session proofs with completed user presence and issuer schema `1` (`proof_of_human`).
- Each proof must match the exact server-signed RP nonce for that authorization attempt.
- The complete session nullifier tuple is hashed and inserted under a unique D1 constraint before OAuth is issued.
- Proof bodies are capped at 256 KiB and World verification requests time out after ten seconds.
- OAuth uses authorization code flow, PKCE S256, exact registered redirects, one-hour access tokens, and 30-day refresh tokens.
- HTTPS is required for registered redirects except loopback localhost development.
- CSP, frame denial, no-referrer, MIME sniffing protection, permissions policy, origin validation, and no-store authorization responses are applied by the Worker.
- MCP output is allow-listed and contains no stable World identifier.
- Public wall projections omit internal subjects; answer text is rendered with `textContent`, capped at 600 characters, and cannot contain links, email addresses, or control characters.
- A unique D1 constraint enforces one replaceable answer per active question and internal connected-account subject.
- Tool instructions treat wall answers as untrusted content and require exact-text user confirmation before public publishing.
- Claim tickets are random, stored only as hashes for lookup, encrypted for controlled reissue, expire after five minutes, and use an atomic D1 processing lease to prevent duplicate Shopify creation.
- Shopify discount codes are random, encrypted at rest, limited to eligible product IDs, expire after 15 minutes, and permit one total redemption.
- Human Grant consent links expire after ten minutes and are bound to both a capability cookie and the browser's World ID session cookie.
- Partner authorization codes expire after five minutes and are consumed once through an authenticated back-channel exchange.
- Assertions use pairwise partner subjects; the World session and internal subject never leave the gateway.
- A D1 primary key across partner, action, and internal subject enforces one-human-one-redemption even under concurrent exchange attempts.

## Tests

`npm test` covers the legacy MCP transport plus the hardened 4.0 proof shape, exact nonce binding, rejection of uniqueness proofs, required user presence, encrypted session storage, opaque stable-subject derivation, the Shopify claim handoff and subject redaction, wall input validation, and public subject redaction. `wrangler deploy --dry-run` validates the production bundle, while the local Worker check exercises OAuth registration/discovery, authorization state, D1 persistence, CSP, and RP signature generation.

World references: [World ID 4.0 migration](https://docs.world.org/world-id/4-0-migration), [RP signatures](https://docs.world.org/world-id/idkit/signatures), and [IDKit integration](https://docs.world.org/world-id/idkit/integrate).
