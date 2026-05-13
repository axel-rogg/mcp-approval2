# =============================================================================
# openbao-config.hcl — OpenBao production config for Fly.io single-node mode.
# =============================================================================
# Plan-Ref: deploy/fly/Dockerfile.openbao, fly.openbao.toml.
#
# Single-node file-backend setup. Sufficient for hobby/private use; if you
# scale to multi-region or need HA, migrate to `storage "raft"` and add
# integrated-storage peers.
#
# Listener is plaintext intra-VPC because Fly's private network (.internal
# DNS) terminates encryption at the wireguard layer between machines. Any
# external access MUST go through mcp-approval2 — never expose 8200 over
# fly.dev or a custom domain.
# =============================================================================

storage "file" {
  path = "/vault/data"
}

listener "tcp" {
  # 0.0.0.0:8200 — bound to all interfaces, but Fly only routes the
  # private wireguard interface to it (no public IP attached in fly.toml).
  address     = "0.0.0.0:8200"
  tls_disable = true
}

# api_addr is what Vault advertises to clients in redirect responses.
# Use the .internal-DNS name so clients in the Fly private network resolve
# to this app's machines.
api_addr     = "http://mcp-approval2-openbao.internal:8200"
cluster_addr = "http://mcp-approval2-openbao.internal:8201"

# Disable mlock — Fly containers don't grant CAP_IPC_LOCK and Vault refuses
# to start with mlock enabled unless the syscall is available.
disable_mlock = true

# Built-in web UI (reachable only via `fly proxy 8200:8200 -a
# mcp-approval2-openbao` from your laptop).
ui = true

# Log to stderr so `fly logs` picks it up.
log_level  = "info"
log_format = "json"
