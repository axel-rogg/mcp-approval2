# ============================================================================
# OpenBao Post-Init Konfiguration
# ============================================================================
#
# Voraussetzung: OpenBao ist deployed (siehe approval2-openbao-fly.tf im
# Hauptmodul) UND `bao operator init` + `bao operator unseal` sind manuell
# durchgeführt worden. Operator-Workflow:
#
#   1. `fly proxy 8200 -a mcp-approval2-openbao` (in einem extra Terminal lassen)
#   2. `export VAULT_ADDR=http://127.0.0.1:8200`
#   3. `export VAULT_TOKEN=<root-token aus operator init>`
#   4. `export DOPPLER_TOKEN=<workplace-scoped personal-token>`
#   5. `terraform init && terraform apply`
#
# Was hier passiert:
#   - Transit-Secrets-Engine wird gemountet (path=transit/)
#   - Master-Key user-dek wird angelegt (datakey-Ableitung pro User on-demand)
#   - AppRole-Auth wird aktiviert
#   - Zwei AppRoles: approval2 + knowledge2 mit je eigener Policy
#   - secret_id wird einmalig generiert + an Doppler gepiped
#
# ⚠️ secret_id-Rotation:
#   Der TF-State enthält den initial-secret_id. Nach 90 Tagen (siehe
#   var.secret_id_ttl_seconds) läuft er ab. Rotation NICHT via `terraform
#   apply -replace=...` (das würde Drift erzeugen), sondern via:
#
#     bao write -force -f auth/approle/role/approval2-fly/secret-id
#     # output: secret_id=...   → in Doppler eintragen
#     bao write -force -f auth/approle/role/knowledge2-fly/secret-id
#
#   Dann State synchron halten:
#     terraform apply -refresh-only
#
# Spec-Reference: docs/privat.md §9.3 + mcp-knowledge2/docs/runbooks/
#                 runbook-as3-cutover.md (Section 1.3)
# ============================================================================

# ---------------------------------------------------------------------------
# Transit-Secrets-Engine
# ---------------------------------------------------------------------------

resource "vault_mount" "transit" {
  path        = var.transit_mount_path
  type        = "transit"
  description = "Per-user DEK derivation für approval2 + knowledge2. Crypto-Shredding-Boundary: löschen eines Keys hier macht alle damit verschlüsselten Daten unwiederbringlich (gewollt für DSGVO-Erase)."

  # Default-lease-TTL für Transit selbst spielt keine Rolle — die
  # datakey/plaintext-Endpoints liefern ephemeren Plaintext, der nicht
  # Vault-gemanaged ist.
}

resource "vault_transit_secret_backend_key" "user_dek" {
  backend = vault_mount.transit.path
  name    = var.transit_key_name

  # aes256-gcm96 ist der Default und matched die crypto-stack-Erwartung
  # (32-Byte-DEKs, GCM-mode in den Adaptern).
  type = "aes256-gcm96"

  # Wichtig: derived=true erzwingt context-binding bei encrypt/decrypt.
  # Für datakey/plaintext brauchen wir das NICHT (die Adapter rufen den
  # Endpoint ohne context auf, jeder Call generiert eine fresh-DEK).
  # Daher derived=false.
  derived = false

  # exportable=false: niemand kann den Master-Key rausziehen, nur Datakeys
  # ableiten. Crypto-Shredding-Boundary intakt.
  exportable             = false
  allow_plaintext_backup = false

  # auto_rotate alle 90 Tage — alte Versions bleiben für decrypt erreichbar,
  # neue Datakeys werden mit dem aktuellsten Master-Version gewrappt.
  auto_rotate_period = 7776000 # 90 d in sec
}

# ---------------------------------------------------------------------------
# AppRole-Auth
# ---------------------------------------------------------------------------

resource "vault_auth_backend" "approle" {
  type        = "approle"
  path        = var.approle_mount_path
  description = "Service-Auth für approval2 + knowledge2. role_id ist eine UUID (nicht-sensitive), secret_id ist eine UUID (sensitive — Doppler-gemanaged)."
}

# ---------------------------------------------------------------------------
# Policies — pro Service eigene Policy
# ---------------------------------------------------------------------------

# approval2: braucht datakey/encrypt/decrypt (KEK-Operations für eigene
# User-Objects), darf Keys auto-create wenn ein neuer User auftaucht.
resource "vault_policy" "approval2" {
  name = "approval2-kms"

  policy = <<-EOT
    # Per-User-DEK-Ableitung (frisch pro Call, keine Persistenz)
    path "${var.transit_mount_path}/datakey/plaintext/${var.transit_key_name}" {
      capabilities = ["update"]
    }

    # Encrypt / Decrypt für KEK-wrap-Operations
    path "${var.transit_mount_path}/encrypt/${var.transit_key_name}" {
      capabilities = ["update"]
    }
    path "${var.transit_mount_path}/decrypt/${var.transit_key_name}" {
      capabilities = ["update"]
    }

    # Key-Read (für Versions-Discovery beim Decrypt alter Daten)
    path "${var.transit_mount_path}/keys/${var.transit_key_name}" {
      capabilities = ["read"]
    }

    # Token-Self-Renew (damit langlebige Worker ihren Token strecken können)
    path "auth/token/renew-self" {
      capabilities = ["update"]
    }
    path "auth/token/lookup-self" {
      capabilities = ["read"]
    }
  EOT
}

# knowledge2: braucht NUR datakey/plaintext für KMS-Resolve.
# Encrypt/Decrypt nicht — KC2 wrapped nichts selbst, das macht approval2.
resource "vault_policy" "knowledge2" {
  name = "knowledge2-kms"

  policy = <<-EOT
    # Per-User-DEK-Ableitung (datakey/plaintext/<key-name>)
    path "${var.transit_mount_path}/datakey/plaintext/${var.transit_key_name}" {
      capabilities = ["update"]
    }

    # Key-Read (für Diagnostics, nicht zwingend)
    path "${var.transit_mount_path}/keys/${var.transit_key_name}" {
      capabilities = ["read"]
    }

    # Token-Self-Renew
    path "auth/token/renew-self" {
      capabilities = ["update"]
    }
    path "auth/token/lookup-self" {
      capabilities = ["read"]
    }
  EOT
}

# ---------------------------------------------------------------------------
# AppRoles — pro Service einer
# ---------------------------------------------------------------------------

resource "vault_approle_auth_backend_role" "approval2" {
  backend   = vault_auth_backend.approle.path
  role_name = "approval2-fly"

  token_policies = [vault_policy.approval2.name]
  token_ttl      = var.approle_token_ttl_seconds
  token_max_ttl  = var.approle_token_max_ttl_seconds

  # Bind nur über secret_id — keine CIDR-Bindung (Fly-Egress-IPs sind
  # dynamisch). Compensating control: Token-TTL kurz halten + secret_id
  # rotation alle 90 Tage.
  bind_secret_id        = true
  secret_id_num_uses    = 0 # 0 = unbegrenzt re-usable bis TTL-Ablauf
  secret_id_ttl         = var.secret_id_ttl_seconds
}

resource "vault_approle_auth_backend_role" "knowledge2" {
  backend   = vault_auth_backend.approle.path
  role_name = "knowledge2-fly"

  token_policies = [vault_policy.knowledge2.name]
  token_ttl      = var.approle_token_ttl_seconds
  token_max_ttl  = var.approle_token_max_ttl_seconds

  bind_secret_id     = true
  secret_id_num_uses = 0
  secret_id_ttl      = var.secret_id_ttl_seconds
}

# ---------------------------------------------------------------------------
# Secret-IDs — einmalig generieren
# ---------------------------------------------------------------------------
#
# secret_ids LANDEN IM TF-STATE (sensitive). R2-EU-Backend ist
# server-seitig encryptet at-rest, aber das ist nur die letzte
# Verteidigungslinie. Rotation-Path siehe Header-Kommentar oben.

resource "vault_approle_auth_backend_role_secret_id" "approval2" {
  backend   = vault_auth_backend.approle.path
  role_name = vault_approle_auth_backend_role.approval2.role_name

  metadata = jsonencode({
    service     = "mcp-approval2"
    environment = "privat"
    rotation    = "every-90d-manual"
  })

  # Nach erstem Apply: nie automatisch ersetzen — Rotation ist manual via
  # `bao write -force` (siehe Header).
  lifecycle {
    ignore_changes = [metadata]
  }
}

resource "vault_approle_auth_backend_role_secret_id" "knowledge2" {
  backend   = vault_auth_backend.approle.path
  role_name = vault_approle_auth_backend_role.knowledge2.role_name

  metadata = jsonencode({
    service     = "mcp-knowledge2"
    environment = "privat"
    rotation    = "every-90d-manual"
  })

  lifecycle {
    ignore_changes = [metadata]
  }
}

# ---------------------------------------------------------------------------
# Doppler-Pipe — role_id + secret_id pro Service
# ---------------------------------------------------------------------------
#
# Diese Resources schreiben die OpenBao-Credentials direkt in die jeweiligen
# Doppler-Configs. Beim nächsten `fly secrets sync` aus deploy/fly/sync-
# secrets.sh werden sie automatisch auf die Fly-Apps gepushed.
#
# role_id ist NICHT sensitive (Vault behandelt ihn wie eine Public-ID),
# Doppler markiert ihn aber per-default als sensitive — passt.

resource "doppler_secret" "approval2_role_id" {
  project = var.doppler_project_approval2
  config  = var.doppler_config_approval2
  name    = "OPENBAO_ROLE_ID"
  value   = vault_approle_auth_backend_role.approval2.role_id
}

resource "doppler_secret" "approval2_secret_id" {
  project = var.doppler_project_approval2
  config  = var.doppler_config_approval2
  name    = "OPENBAO_SECRET_ID"
  value   = vault_approle_auth_backend_role_secret_id.approval2.secret_id

  # Bei manueller Rotation (bao write -force) wird der Wert hier
  # outdated. Operator muss in Doppler nachziehen. Lifecycle-ignore_changes
  # wäre falsch — wir WOLLEN den fresh-TF-managed-secret hier abbilden.
  # Stattdessen: terraform apply -refresh-only nach Rotation.
}

resource "doppler_secret" "approval2_openbao_addr" {
  project = var.doppler_project_approval2
  config  = var.doppler_config_approval2
  name    = "OPENBAO_ADDR"
  # Fly-internal 6PN-Adresse — approval2 erreicht den OpenBao-App-Container
  # über die private Fly-Netz-DNS-Auflösung.
  value = "http://mcp-approval2-openbao.internal:8200"
}

resource "doppler_secret" "approval2_openbao_transit_path" {
  project = var.doppler_project_approval2
  config  = var.doppler_config_approval2
  name    = "OPENBAO_TRANSIT_PATH"
  value   = var.transit_mount_path
}

resource "doppler_secret" "knowledge2_role_id" {
  project = var.doppler_project_knowledge2
  config  = var.doppler_config_knowledge2
  name    = "OPENBAO_ROLE_ID"
  value   = vault_approle_auth_backend_role.knowledge2.role_id
}

resource "doppler_secret" "knowledge2_secret_id" {
  project = var.doppler_project_knowledge2
  config  = var.doppler_config_knowledge2
  name    = "OPENBAO_SECRET_ID"
  value   = vault_approle_auth_backend_role_secret_id.knowledge2.secret_id
}

resource "doppler_secret" "knowledge2_openbao_addr" {
  project = var.doppler_project_knowledge2
  config  = var.doppler_config_knowledge2
  name    = "OPENBAO_ADDR"
  value   = "http://mcp-approval2-openbao.internal:8200"
}

resource "doppler_secret" "knowledge2_openbao_transit_path" {
  project = var.doppler_project_knowledge2
  config  = var.doppler_config_knowledge2
  name    = "OPENBAO_TRANSIT_PATH"
  value   = var.transit_mount_path
}
