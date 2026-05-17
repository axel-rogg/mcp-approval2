# ============================================================================
# Multi-User-Readiness-Sprint Secrets (2026-05-17)
# ============================================================================
#
# Heutiger Sicherheits-Sprint hat Cross-Repo Code-Aenderungen deployed
# (knowledge2 commits 19b60f8 + 38b3ec1 + d4a0b34, approval2 commit 9c4813f):
#
#   * SEC-K-009 Service-Token-Split: pro Internal-Route (`/v1/internal/{erase-user,
#     users/sync,health-deep}`) ein eigenes Secret. `requireServiceToken(scope)`
#     in KC2 prueft scope-spezifisch; faellt auf legacy `SERVICE_TOKEN`
#     zurueck wenn der scope-Wert nicht gesetzt ist.
#   * SEC-K-016 + MUSS-§4.1.2 Erase-Receipt-JWS: `REQUIRE_ERASE_RECEIPT=true`
#     enforced einen JWS-Header `x-erase-receipt` (signed von approval2,
#     `payload.sub === body.user_id`) auf erase-user. Default false →
#     legacy-Pfad (confirmation_token-length-Check).
#
# Diese TF-Datei materialisiert die Werte:
#   * Single source: 3× `random_password` (length=64, alphanumeric) hier.
#   * Doppelte `doppler_secret`-Resourcen pushen denselben Wert in beide
#     Doppler-Projekte (mcp-knowledge2/privat erwartet, mcp-approval2/fly
#     schickt). Damit ist Symmetrie TF-state-garantiert.
#   * `REQUIRE_ERASE_RECEIPT` startet auf `"false"` (Migrations-Window).
#     Im Cutover-Window T+40min flippt der Operator den Wert auf `"true"`
#     entweder hier (apply) oder direkt im Doppler-UI.
#
# Cross-Repo-Doku:
#   * docs/plans/active/PLAN-as3-bigbang.md §5.1.5 (Sprint-Aktivierungs-Block)
#   * SECURITY_ISSUES.md (mcp-knowledge2) — SEC-K-005/009/016
#   * docs/plans/active/PLAN-multi-user-readiness.md (mcp-knowledge2) — Sprint-Closure-Matrix
# ============================================================================

# ----------------------------------------------------------------------------
# Single source: 3 scope-Tokens als random_password
# ----------------------------------------------------------------------------
#
# length=64, special=false, alle 3 Klassen aktiv → 64 chars [a-zA-Z0-9].
# Passt zu KC2's `z.string().min(32)`-Schema (`src/types/env.ts`) +
# approval2's identischem Erwartungs-Schema.
# Crypto-Quelle: Terraform's `random` provider → Go-stdlib `crypto/rand`.

resource "random_password" "multiuser_service_token_erase" {
  length  = 64
  special = false
  upper   = true
  lower   = true
  numeric = true
}

resource "random_password" "multiuser_service_token_sync" {
  length  = 64
  special = false
  upper   = true
  lower   = true
  numeric = true
}

resource "random_password" "multiuser_service_token_ops" {
  length  = 64
  special = false
  upper   = true
  lower   = true
  numeric = true
}

# ----------------------------------------------------------------------------
# KC2-Seite (Project: mcp-knowledge2, Config: privat)
# ----------------------------------------------------------------------------
#
# KC2 erwartet diese Namen wortlich in src/types/env.ts:
#   SERVICE_TOKEN_ERASE / SERVICE_TOKEN_SYNC / SERVICE_TOKEN_OPS
# Verifikation laeuft in src/auth/service_token.ts `requireServiceToken(scope)`.

resource "doppler_secret" "knowledge2_service_token_erase_privat" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = "SERVICE_TOKEN_ERASE"
  value   = random_password.multiuser_service_token_erase.result
}

resource "doppler_secret" "knowledge2_service_token_sync_privat" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = "SERVICE_TOKEN_SYNC"
  value   = random_password.multiuser_service_token_sync.result
}

resource "doppler_secret" "knowledge2_service_token_ops_privat" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = "SERVICE_TOKEN_OPS"
  value   = random_password.multiuser_service_token_ops.result
}

# REQUIRE_ERASE_RECEIPT — Variable damit Operator im Cutover-Window
# mit einem Liner-Apply zwischen "false" (Migrations-Window) und "true"
# (enforced) wechseln kann, ohne den .tf-Code zu editieren.
#
# Default ist "false" (sicher waehrend Deploy + Migration). Flip:
#   bash scripts/cutover-enforce-erase-receipt.sh
# oder direkt:
#   terraform apply -var=require_erase_receipt=true \
#     -target=doppler_secret.knowledge2_require_erase_receipt_privat
variable "require_erase_receipt" {
  type        = string
  description = "REQUIRE_ERASE_RECEIPT flag fuer KC2. 'false' = legacy (confirmation_token-length-Check). 'true' = JWS-Receipt-Pflicht (SEC-K-016 enforced). Flip im Cutover-Window."
  default     = "false"
  validation {
    condition     = contains(["false", "true"], var.require_erase_receipt)
    error_message = "require_erase_receipt muss 'false' oder 'true' sein (String, nicht boolean — Doppler-Env-Konvention)."
  }
}

resource "doppler_secret" "knowledge2_require_erase_receipt_privat" {
  project = doppler_project.knowledge2.name
  config  = doppler_environment.knowledge2_privat.slug
  name    = "REQUIRE_ERASE_RECEIPT"
  value   = var.require_erase_receipt
}

# ----------------------------------------------------------------------------
# approval2-Seite (Project: mcp-approval2, Config: fly)
# ----------------------------------------------------------------------------
#
# approval2 erwartet diese Namen in apps/server/src/index.ts BootEnv:
#   MCP_KNOWLEDGE_SERVICE_TOKEN_ERASE / _SYNC / _OPS
# Werden in createKnowledgeService durchgereicht an HttpKnowledgeAdapter
# (packages/adapters/src/knowledge/http-client.ts) `pickServiceToken(path)`.

resource "doppler_secret" "approval2_mcp_knowledge_service_token_erase_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "MCP_KNOWLEDGE_SERVICE_TOKEN_ERASE"
  value   = random_password.multiuser_service_token_erase.result
}

resource "doppler_secret" "approval2_mcp_knowledge_service_token_sync_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "MCP_KNOWLEDGE_SERVICE_TOKEN_SYNC"
  value   = random_password.multiuser_service_token_sync.result
}

resource "doppler_secret" "approval2_mcp_knowledge_service_token_ops_fly" {
  project = "mcp-approval2"
  config  = "fly"
  name    = "MCP_KNOWLEDGE_SERVICE_TOKEN_OPS"
  value   = random_password.multiuser_service_token_ops.result
}

# ----------------------------------------------------------------------------
# Outputs (Operator-Diagnostics)
# ----------------------------------------------------------------------------
#
# Werte sind `sensitive = true` damit Terraform sie nicht ins Plain-Output
# druckt. Operator kann sie bei Bedarf via `terraform output -raw <name>`
# einzeln pullen (z.B. zum Smoke-Test).

output "multiuser_service_token_erase" {
  value       = random_password.multiuser_service_token_erase.result
  sensitive   = true
  description = "SERVICE_TOKEN_ERASE — KC2 + approval2 (identisch). Fuer Smoke-Test ueber `terraform output -raw multiuser_service_token_erase`."
}

output "multiuser_service_token_sync" {
  value       = random_password.multiuser_service_token_sync.result
  sensitive   = true
  description = "SERVICE_TOKEN_SYNC — KC2 + approval2 (identisch)."
}

output "multiuser_service_token_ops" {
  value       = random_password.multiuser_service_token_ops.result
  sensitive   = true
  description = "SERVICE_TOKEN_OPS — KC2 + approval2 (identisch)."
}