---
name: world-id-account
description: Check whether the unified World ID hub connection is active. Use when the user asks whether the World ID plugin is connected.
---

# World ID account

Use only the bundled `world-id-hub` MCP connection.

1. Call `get_world_id_hub` with no arguments.
2. Say the plugin connection is active only when the response has `world_id_connected: true`.
3. Otherwise say the connection could not be determined.
4. Do not infer or report a World ID verification level from this tool. It establishes the hub connection, not fresh human presence or downstream-provider authorization.

Report only connection status. Never quote raw tool output or disclose personal identifiers, even when the user asks for them.
