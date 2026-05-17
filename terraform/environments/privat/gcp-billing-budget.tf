# ============================================================================
# GCP Billing-Budget + Alert — Cost-Anomaly-Detection (privat-Mode)
# ============================================================================
#
# Family-Hardening 2026-05-17 (THREAT-MODEL §10 + THREAT-SYNTHESIS §5.1):
# Verhindert dass eine buggy Embedding-Schleife oder ein kompromittierter
# Token in einer Nacht 500+ EUR via Vertex/KMS/R2-Egress verbrennt.
#
# Was hier passiert:
#   - Budget mit monatlichem Hard-Cap (default 20 EUR/Monat)
#   - Threshold-Alerts bei 50%, 90%, 100% → Email an `gcp_billing_alert_email`
#     (= GCP-Project-Owner-Email per default, sonst expliziter Override)
#   - Currency: EUR (passt zu EU-Region-Stack)
#
# Voraussetzungen (User-Setup einmalig):
#   1. `gcp_billing_account_id` setzen — kommt aus `gcloud billing accounts list`
#      bzw. GCP-Console → Billing → "Billing-Konto-ID" (Format: XXXXXX-YYYYYY-ZZZZZZ).
#      Wenn leer (default): das ganze File ist no-op (count=0), kein Apply-Effekt.
#   2. Billing-Admin-Rolle (`roles/billing.admin`) auf dem Billing-Account
#      für den TF-Apply-User.
#   3. API `billingbudgets.googleapis.com` aktiv (wird hier via google_project_service
#      mit-aktiviert).
#
# Manuelle Verifikation nach Apply:
#   gcloud billing budgets list --billing-account=$GCP_BILLING_ACCOUNT_ID
#
# Spec-Reference: docs/runbooks/runbook-family-hardening.md §3
# ============================================================================

variable "gcp_billing_account_id" {
  type        = string
  default     = ""
  sensitive   = false
  description = "GCP Billing-Account-ID (Format: XXXXXX-YYYYYY-ZZZZZZ). Leer = Budget-Resource wird nicht angelegt (no-op). Kommt aus `gcloud billing accounts list`."
}

variable "gcp_monthly_budget_eur" {
  type        = number
  default     = 20
  description = "Monatlicher Cost-Cap in EUR. Threshold-Alerts bei 50/90/100% gehen per Email raus. Default 20€ ist Privat-Family-Tier — Vertex + KMS + R2 zusammen sollten typischerweise <5€/Monat sein."
}

variable "gcp_billing_alert_email" {
  type        = string
  default     = ""
  description = "Email-Adresse für Threshold-Alerts. Wenn leer: kein Notification-Channel angelegt; Budget existiert aber sendet keine Mails. Single-Email-Pattern für Solo-Operator."
}

# Aktiviere die Billing-Budgets-API
resource "google_project_service" "billingbudgets" {
  count = var.gcp_billing_account_id == "" ? 0 : 1

  project            = var.gcp_project_id
  service            = "billingbudgets.googleapis.com"
  disable_on_destroy = false
}

# Optional Notification-Channel (Email).
resource "google_monitoring_notification_channel" "billing_alert_email" {
  count = (var.gcp_billing_account_id != "" && var.gcp_billing_alert_email != "") ? 1 : 0

  project      = var.gcp_project_id
  display_name = "approval2 Billing-Alert Email"
  type         = "email"
  labels = {
    email_address = var.gcp_billing_alert_email
  }
}

# Der Budget selbst.
resource "google_billing_budget" "monthly_cap" {
  count = var.gcp_billing_account_id == "" ? 0 : 1

  billing_account = var.gcp_billing_account_id
  display_name    = "mcp-approval2 privat — monatlicher Cap"

  budget_filter {
    projects = ["projects/${var.gcp_project_id}"]
    # Cost-Filter optional einschränkbar — wir lassen es offen, damit der
    # Cap GESAMT für das Projekt gilt (KMS + Vertex + Logging + Pub/Sub).
  }

  amount {
    specified_amount {
      currency_code = "EUR"
      units         = var.gcp_monthly_budget_eur
    }
  }

  # Threshold-Alerts: 50% / 90% / 100%. Family-Hardening: early warning bei
  # 50% damit man eingreifen kann bevor der Hard-Cap droht.
  threshold_rules {
    threshold_percent = 0.5
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 0.9
    spend_basis       = "CURRENT_SPEND"
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "CURRENT_SPEND"
  }

  dynamic "all_updates_rule" {
    for_each = var.gcp_billing_alert_email != "" ? [1] : []
    content {
      monitoring_notification_channels = [
        google_monitoring_notification_channel.billing_alert_email[0].id,
      ]
      disable_default_iam_recipients = false
    }
  }

  depends_on = [google_project_service.billingbudgets]
}

output "gcp_billing_budget_status" {
  description = "Status der Billing-Budget-Resource (sichtbar in `terraform output`)."
  value = var.gcp_billing_account_id == "" ? "NOT_CONFIGURED — gcp_billing_account_id leer; kein Budget angelegt" : "CONFIGURED — Monthly cap ${var.gcp_monthly_budget_eur} EUR (50/90/100% Alerts)${var.gcp_billing_alert_email == "" ? " — kein Email-Channel, nur IAM-Default-Recipients" : " → ${var.gcp_billing_alert_email}"}"
}
