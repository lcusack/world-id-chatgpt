---
name: maitre-booking
description: Find, claim, view, and cancel Maître restaurant reservations. Use for Maître tables or when the user selects the Maître World ID benefit and wants to claim or book it.
---

# Maître bookings

Use Maître only through the bundled `world-id-hub` MCP. Do not ask the user to install Maître separately.

## World ID benefit

For a request about the Maître World ID benefit, call `get_world_id_hub` and reuse the selected listing from the official production World ID catalog. Do not substitute another environment or an unpublished offer. If Maître is not listed, say so; direct browsing may still be available.

Use the listing's actual terms. Access to tables does not imply a discount or free meal. A catalog listing or successful World ID account check does not establish Maître eligibility, authorize a booking, or confirm redemption. Never pass World ID proofs, tokens, subjects, continuity handles, nullifiers, wallets, biometrics, or other private identifiers to Maître.

## Browse and claim

1. If Maître's `connection_state` is not `ready`, call `connect_world_id_partner` with `provider: maitre` and show the returned authorization link.
2. Call `get_world_id_partner_tools` before the first delegated operation, then call `read_world_id_partner` with `list_seats` for current availability. Its optional `day` is YYYY-MM-DD in America/Los_Angeles. Never invent availability or seat IDs.
3. Obtain the user's selection of restaurant, local date/time, and party size. Ask for a guest name only if the user wants an override or the live schema requires one.
4. Call `act_world_id_partner` with `claim_seat`; the hub will require confirmation before delegating the write.
   - If it returns `status: confirmation_required`, show the exact stored booking arguments and ask for explicit approval. After approval, call the tool again with the same provider and tool plus the returned `confirmation_token`. If any detail changes, discard the token and request a new confirmation; tokens expire and are single-use.
5. Report the returned restaurant, local date/time, party size, guest name, claim reference, and exact status. `pending` means restaurant confirmation is outstanding; do not call it confirmed.

For a seat conflict, refresh availability and let the user choose. For a timeout or unknown write result, delegate `my_reservations` through `read_world_id_partner` before considering a retry. If the result remains ambiguous, stop writes and report the uncertainty.

## Sign-in and World ID verification

Maître MCP uses its own OAuth connection. The official World ID MCP connection does not authorize Maître. If any delegated tool returns `status: reauthorization_required`, show its exact `connect_url` as a clickable **Reconnect Maître** link. Explain that no provider action was performed, wait for the user to complete sign-in, and then re-read availability before requesting a new booking confirmation.

If `claim_seat` returns `verification_required` with a `verification_url` and `handoff`:

1. Show the exact URL as a clickable **Connect World ID** link and tell the user to use the same Google account as their Maître connection.
2. Delegate `wait_for_verification` through `read_world_id_partner` with the returned handoff while the turn remains active.
3. On `pending`, continue with the same handoff. On `verification_required`, show the replacement URL and use the new handoff.
4. On `verified`, retry the already-approved claim without asking again. Verification does not hold the table, so availability may have changed.
5. On timeout, recovery-required, or another error, stop polling and show any returned recovery URL. Do not create a new handoff simply to extend the waiting window.

Do not try to transfer credentials from the World ID MCP or bypass Maître's backend verification.

## Manage reservations

Delegate `my_reservations` through `read_world_id_partner` to read claim IDs and current statuses. Cancel only a specific reservation the user asks to cancel, delegating `cancel_reservation` through `act_world_id_partner`.

- `cancelled`: report completion.
- `cancellation_requested`: explain that restaurant cancellation remains outstanding.
- Unknown result: recheck `my_reservations` through the read bridge; do not report success or book a replacement until resolved.

If the user asks to disconnect Maître, explain that the current hub does not expose Maître's logout operation. Do not imply that disconnecting Maître would cancel reservations or disconnect World ID.
