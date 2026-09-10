# GitHub MCP diagnostic matrix

Use the connected agent's GitHub MCP tools, never a CLI/API fallback.

| Evidence | Result |
|---|---|
| tool absent | `missing-tool` |
| HTTP 401 | `authentication-failed` |
| HTTP 403 | `permission-denied` |
| operation completed | `ok` |
| no live call made | `live-check-not-run` |

Issue reads and Project reads are independent checks. For Project 2, resolve
actual field names and item values before discussing Status or Priority. The
current environment recorded Issue access as working while `get_me` and the
Project endpoint returned 403; this is an observed diagnostic result, not a
permission change request.
