# Provider requirements for the `privat` workspace.
#
# Mirrors the root /terraform/versions.tf but is needed locally because
# environments are independent Terraform root modules (each has its own
# .terraform/ + state file).

terraform {
  required_version = ">= 1.6"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    doppler = {
      source  = "DopplerHQ/doppler"
      version = "~> 1.13"
    }
  }
}
