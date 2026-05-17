# ============================================================================
# GitHub Actions — FLY_API_TOKEN-Spiegelung in beide Repos
# ============================================================================
#
# Bewusste Ausnahme zur in modules/github-repo/secrets.tf dokumentierten
# "Bootstrap-Token-only via TF"-Regel: FLY_API_TOKEN wird ZUSÄTZLICH zum
# DOPPLER_TOKEN_GHA-Bootstrap direkt von TF in beide GH-Repos gepusht.
#
# Begründung (2026-05-17, User-Decision "Option 3"):
#   - FLY_API_TOKEN ist Org-scoped (per `fly tokens create org`) und gilt für
#     beide Apps (mcp-approval2 + mcp-knowledge2). Single TF-managed Source
#     hält ihn synchron in beiden Repos.
#   - Doppler->GitHub-Sync (Option 2 in der Diskussion) wäre Alternative,
#     verlangt aber UI-Setup pro Repo. TF-Pfad ist explizit + audit-trail-
#     freundlich (Replace via `terraform apply -replace=` bei Rotation).
#
# Rotation-Workflow (alle 8760h / 1 Jahr ab Token-Mint):
#   1. Neuen Org-Token minten:
#      flyctl tokens create org -o personal --expiry 8760h
#   2. In beide Doppler-Configs einspielen:
#      doppler secrets set FLY_API_TOKEN="$NEW" -p mcp-approval2 -c fly --silent
#      doppler secrets set FLY_API_TOKEN="$NEW" -p mcp-knowledge2 -c fly --silent
#   3. terraform apply -refresh-only (zieht den neuen Wert in beide GH-Secrets)
#   4. Alter Token läuft natürlich ab oder wird via
#      flyctl tokens revoke <id> sofort invalidiert.
#
# State-Sensitivity: das Plaintext-Token landet im TF-State (R2-EU, at-rest-
# encryptet). Gleicher blast-radius wie DOPPLER_TOKEN_GHA.
# ============================================================================

resource "github_actions_secret" "fly_api_token_approval2" {
  repository      = "mcp-approval2"
  secret_name     = "FLY_API_TOKEN"
  value = var.fly_api_token
}

resource "github_actions_secret" "fly_api_token_knowledge2" {
  repository      = "mcp-knowledge2"
  secret_name     = "FLY_API_TOKEN"
  value = var.fly_api_token
}
