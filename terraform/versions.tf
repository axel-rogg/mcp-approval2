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
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# Provider config lives at the environment level (environments/<name>/main.tf)
# so each workspace can target a different Hetzner project / GCP project /
# Cloudflare account if needed. Credentials are read from env vars:
#   HCLOUD_TOKEN
#   CLOUDFLARE_API_TOKEN
#   GOOGLE_APPLICATION_CREDENTIALS (path to service-account JSON, business workspace only)
