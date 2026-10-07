---
name: agentmail-verified-email
description: Connect and use AgentMail through the unified World ID hub for agent inboxes, drafts, messages, and World ID verified-organization email. Use when the user asks to connect AgentMail, create or inspect an agent inbox, draft or send agent email, or use the AgentMail World ID footer.
---

# AgentMail verified email

Use AgentMail only through the bundled `world-id-hub` MCP. Do not ask the user to install AgentMail separately or provide an API key, OAuth token, World ID proof, subject, nullifier, wallet, biometric data, or other secret.

## Connect and inspect

1. Call `get_world_id_hub` to inspect the AgentMail connection state. If it is not `ready`, call `connect_world_id_partner` with `provider: agentmail` and show the returned provider-hosted authorization link.
2. After connection, call `get_world_id_partner_tools` before the first delegated operation so arguments match AgentMail's live schema.
3. Use `read_world_id_partner` for AgentMail reads and `act_world_id_partner` for writes. Pass only an allowlisted AgentMail tool name and arguments matching the returned live schema.
   - If a write returns `status: confirmation_required`, show the exact stored arguments to the user and ask for explicit approval. After approval, call `act_world_id_partner` again with the same provider and tool plus the returned `confirmation_token`; the hub will execute the stored arguments. Do not pass the token before approval.
   - If the user changes any recipient, subject, body, attachment, or other action detail, discard the prior token and call with the revised arguments to generate a new confirmation. Tokens expire and can be used only once.
4. If the user belongs to multiple organizations, show their names and call the write bridge with `select_organization` only after they choose one.
5. If AgentMail reports that no account exists, direct the user to create one at `https://console.agentmail.to` and reconnect. Never substitute the World ID hub session for AgentMail authorization.
6. To enable AgentMail's organization-level World ID treatment, direct the user to AgentMail Console → Account → Connected accounts → World ID. The hub connection and the connected account inside AgentMail remain separate relying-party relationships.
7. If a delegated tool returns `status: reauthorization_required`, show its exact `connect_url` as a clickable **Reconnect AgentMail** link. Explain that no provider action was performed and wait for sign-in before retrying.

## Work with email

Delegate these existing AgentMail tools through the hub:

- `list_inboxes`, `search_inboxes`, and `get_inbox` for inbox discovery.
- `create_inbox` only when the user asks to create one. Confirm a requested address or display name before creation when ambiguity could matter.
- `list_messages`, `search_messages`, `get_message`, and `get_thread` for reading mail.
- `create_draft` or `update_draft` when the user asks to compose but has not clearly asked to send.
- `send_message`, `send_draft`, `reply_to_message`, or `forward_message` only after the user has explicitly approved the final recipients, subject, and body. Treat every send as an external representational action.

Before sending, summarize the sender inbox, To/Cc/Bcc recipients, subject, attachments, and whether the body is final. Do not imply delivery until AgentMail returns a successful message result. Return the resulting message and thread identifiers only when they are useful; do not make the user handle internal IDs.

## Distinguish the assurance

AgentMail's World ID footer means the AgentMail organization is connected to a World ID verified human. It does not prove that a human reviewed the exact email. Never describe organization-level verification as per-message approval, authorship, legal identity verification, or proof that the email's contents are true.

If the user asks for exact-message human approval, explain that this IdP-only plugin does not provide that separate capability. Do not route them to an experimental or unlisted service.
