#!/bin/sh
# Defense in depth only: agents that do not support pre-tool hooks still rely on
# the project's least-privilege MCP configuration.
set -eu

payload=$(dd bs=1 count=32768 2>/dev/null || true)

block() {
  printf '%s\n' 'blocked unsafe secret-bearing command' >&2
  exit 1
}

# A pre-tool event without a shell command is not this hook's concern. If a
# command field is present but cannot be represented as a JSON string, deny it.
case "$payload" in
  *'"command"'*) ;;
  *) exit 0 ;;
esac
if ! printf '%s' "$payload" | grep -Eq '"command"[[:space:]]*:[[:space:]]*"'; then
  block
fi

# Match command tokens rather than substrings: environment and printenv-safe
# must remain usable.  The input is never echoed or persisted.
if printf '%s' "$payload" | grep -Eq '(^|[";&|()[:space:]])op[[:space:]]+read(["[:space:];&|()]|$)'; then
  block
fi
if printf '%s' "$payload" | grep -Eq '(^|[";&|()[:space:]])(env|printenv)(["[:space:];&|()]|$)'; then
  block
fi
if printf '%s' "$payload" | grep -Eq '(^|[";&|()[:space:]])(cat|sed|awk|head|tail)[[:space:]]+([^;&|()[:space:]]*/)?\.env(["[:space:];&|()]|$)'; then
  block
fi

exit 0
