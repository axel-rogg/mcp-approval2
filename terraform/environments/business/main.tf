# ============================================================================
# STUB — environments/business
# ============================================================================
#
# Phase-2 placeholder for the GCP-backed business deployment.
# See: docs/plans/active/PLAN-hetzner-deployment.md §14 (Multi-Instance-Pattern)
#
# When activated, this file will look approximately like:
#
#   provider "google" {
#     project = var.gcp_project_id
#     region  = var.gcp_region
#   }
#
#   provider "cloudflare" {}
#
#   module "vm" {
#     source                    = "../../modules/gcp-mcp-instance"
#     instance_name             = "business"
#     environment               = "business"
#     gcp_project_id            = var.gcp_project_id
#     gcp_region                = var.gcp_region
#     container_image_mcp       = var.container_image_mcp
#     container_image_knowledge = var.container_image_knowledge
#   }
#
#   module "dns" {
#     source           = "../../modules/cloudflare-dns"
#     zone_id          = var.cloudflare_zone_id
#     instance_name    = "business"
#     target_ipv4      = module.vm.lb_ipv4
#     domain_mcp       = "mcp-biz.ai-toolhub.org"      # or firma-domain
#     domain_knowledge = "knowledge-biz.ai-toolhub.org"
#     domain_app       = "app-biz.ai-toolhub.org"
#     proxied          = false
#   }
#
# TODO Phase 2:
#   - Decide DNS strategy: ai-toolhub.org-subdomain vs. firma-owned domain
#   - Decide GCP architecture: Cloud Run v2 (stateless) vs. GCE-VM
#   - Provision backend.tf with separate state key
#   - Wire WIF (Workload Identity Federation) for cross-account IAM if needed
