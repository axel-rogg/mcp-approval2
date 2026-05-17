# Provider-Versions für das business-Workspace.
# Mirror der approval2/privat-versions plus Doppler.

terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
    doppler = {
      source  = "DopplerHQ/doppler"
      version = "~> 1.18"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
