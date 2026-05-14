# Caddyfile.tpl — render with `bash render-config.sh` (substitutes ${VAR})
#
# Substituted variables (from .env):
#   ${ACME_EMAIL}        — Let's Encrypt notification address
#   ${DOMAIN_MCP}        — main MCP endpoint (e.g. mcp2.ai-toolhub.org)
#   ${DOMAIN_KNOWLEDGE}  — knowledge-core endpoint
#   ${DOMAIN_APP}        — PWA frontend (same backend as DOMAIN_MCP)
#   ${HETZNER_FQDN_V4}   — optional Coop-Zscaler-bypass FQDN
#                          (Hetzner-default reverse-DNS, *.your-server.de).
#                          If empty, the bypass vhost is omitted at render
#                          time (see render-config.sh).
#
# Result is written to ./Caddyfile and mounted into the Caddy container.

{
  email ${ACME_EMAIL}
  # Sensible defaults; tweak per environment if needed.
  servers {
    protocols h1 h2 h3
  }
}

# ── mcp-approval2: MCP server + admin + .well-known/jwks.json ──────────────
${DOMAIN_MCP} {
  encode zstd gzip

  # Sensible security headers (matches mcp-approval prod).
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    # Remove server fingerprinting.
    -Server
  }

  reverse_proxy mcp-approval2:8787 {
    health_uri /health
    health_interval 30s
    health_timeout 5s
  }
}

# ── mcp-knowledge2: storage / search service ───────────────────────────────
${DOMAIN_KNOWLEDGE} {
  encode zstd gzip

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }

  reverse_proxy mcp-knowledge2:8788 {
    health_uri /health
    health_interval 30s
    health_timeout 5s
  }
}

# ── PWA on app.* — same backend as DOMAIN_MCP ──────────────────────────────
# The PWA bundle is served by mcp-approval2 directly. We split the host to
# keep WebAuthn origins clean (separate RP_ID is configurable later).
${DOMAIN_APP} {
  encode zstd gzip

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }

  reverse_proxy mcp-approval2:8787
}

# ── Coop-Bypass: Hetzner-Default-FQDN (*.your-server.de) ───────────────────
# Backstory: Coop-Firmen-Browser laeuft hinter Zscaler-Proxy, der unsere
# eigene Domain *.ai-toolhub.org als "newly registered" blockt — aber
# *.your-server.de wird durchgelassen. Wir exposen die gleichen Backends
# zusaetzlich unter dieser FQDN.
#
# WebAuthn-Hinweis: Origin ist hier eine andere als ${DOMAIN_MCP}, der
# Coop-Browser muss einen SEPARATEN Passkey enrollen. Beide Passkeys
# gehoeren demselben User-Account (siehe runbook-coop-bypass.md).
#
# ${HETZNER_FQDN_V4} wird vom render-config.sh ggf. weggelassen, wenn
# in .env nicht gesetzt — der vhost-Block existiert dann gar nicht.
${HETZNER_FQDN_V4} {
  encode zstd gzip

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains; preload"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
    -Server
  }

  # Routet PWA + Approval-API + MCP-Endpoints — selbes Backend wie
  # ${DOMAIN_MCP}. mcp-knowledge2 wird bewusst NICHT exposed hier
  # (intra-network only).
  reverse_proxy mcp-approval2:8787 {
    health_uri /health
    health_interval 30s
    health_timeout 5s
  }
}
