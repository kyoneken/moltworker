# Cloudflare MCP connections

The base profile adds only the official Docs server at
`https://docs.mcp.cloudflare.com/mcp`. The optional `observability` profile
also adds `https://observability.mcp.cloudflare.com/mcp`.

Both are remote Streamable HTTP connections. OAuth approval is performed by the
user's selected client and tokens remain in that client's secure store. Setup
does not read production logs, send prompts, or change R2, DNS, Workers, or AI
Gateway resources. A client that cannot load remote MCP keeps its existing
configuration and reports the connection as unsupported.
