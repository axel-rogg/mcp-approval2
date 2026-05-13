# Caddyfile.tpl — render with `bash render-config.sh` (substitutes ${VAR})
#
# Substituted variables (from .env):
#   ${ACME_EMAIL}        — Let's Encrypt notification address
#   ${DOMAIN_MCP}        — main MCP endpoint (e.g. mcp2.ai-toolhub.org)
#   ${DOMAIN_KNOWLEDGE}  — knowledge-core endpoint
#   ${DOMAIN_APP}        — PWA frontend (same backend as DOMAIN_MCP)
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
