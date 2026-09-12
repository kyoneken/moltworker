# Cloudflare MCP connections

The repository's root `apm.yml` adds only the official Docs server at
`https://docs.mcp.cloudflare.com/mcp`. Add Observability explicitly with
APM's self-defined MCP command and re-run the target install:

```sh
apm install --mcp cloudflare-observability --transport streamable-http \
  --url https://observability.mcp.cloudflare.com/mcp --target <target>
apm install --only mcp --target <target> --frozen
```

Both are remote Streamable HTTP connections. OAuth approval is performed by the
user's selected client and tokens remain in that client's secure store. Setup
does not read production logs, send prompts, or change R2, DNS, Workers, or AI
Gateway resources. A client that cannot load remote MCP keeps its existing
configuration and reports the connection as unsupported.
