# Provider requirements for the `privat` workspace.
#
# Mirrors the root /terraform/versions.tf but is needed locally because
# environments are independent Terraform root modules (each has its own
# .terraform/ + state file).
#
# hcloud-Provider entfernt mit Fly.io-Switch (2026-05-17). Module
# terraform/modules/hetzner-mcp-instance/ bleibt als Audit-Trail aber wird
# nicht mehr referenziert. Bei Re-Aktivierung des Hetzner-Pfads:
# hcloud-Block wieder reinrenehmen.

terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    doppler = {
      source  = "DopplerHQ/doppler"
      version = "~> 1.13"
    }
    fly = {
      source  = "fly-apps/fly"
      version = "~> 0.0.23"
    }
  }
}
