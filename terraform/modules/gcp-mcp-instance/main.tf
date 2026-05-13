# ============================================================================
# STUB — gcp-mcp-instance
# ============================================================================
#
# This module is a placeholder for Phase 2 (business workspace).
# See: docs/plans/active/PLAN-hetzner-deployment.md §14 (Multi-Instance-Pattern)
#
# When the business workspace is activated, this module will provision:
#
#   - google_cloud_run_v2_service        — stateless MCP + Knowledge containers
#   - google_sql_database_instance       — Cloud SQL Postgres (encrypted, HA)
#   - google_sql_database                — schema
#   - google_sql_user                    — app role
#   - google_kms_key_ring + key          — CMEK for at-rest encryption
#   - google_service_account             — runtime identity
#   - google_project_iam_member          — bindings (Cloud Run -> SQL Client, KMS Decrypter)
#   - google_secret_manager_secret       — bearer tokens, OAuth client secrets, master keys
#   - google_storage_bucket              — R2-equivalent (or stay on Cloudflare R2)
#   - google_compute_global_address      — static IPv4 for the LB
#   - google_compute_managed_ssl_certificate — auto-managed TLS
#
# The outputs match `hetzner-mcp-instance` 1:1 so the calling environment
# can stay agnostic:
#
#   output "vm_ipv4"       — global LB anycast IP
#   output "vm_ipv6"       — empty string (Cloud Run v2 doesn't expose v6 yet)
#   output "ssh_user"      — null
#   output "instance_id"   — Cloud Run service name
#
# TODO Phase 2:
#   1. Decide: Cloud Run v2 (stateless, container) vs. GCE-VM (mirrors Hetzner)
#   2. Define KMS-key rotation policy (annual default)
#   3. Cloud SQL: shared core / 1 vCPU is enough for single-tenant business
#   4. Cost target: <50 EUR/month idle (Cloud Run scale-to-zero + db-f1-micro)

# Variables are declared but unused — keeps the module signature stable so
# the environments/business/main.tf can already be written.

terraform {
  # No resources yet — intentional. terraform validate on this module
  # passes because no required_providers block is needed when no resources
  # are declared.
}
