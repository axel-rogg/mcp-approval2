# Provider requirements for the github-repo module.
#
# Pinned to the official `integrations/github` provider. `random` is included
# so future extensions (e.g. auto-generated webhook secrets) can pull from it
# without bumping the module-level version constraints.

terraform {
  required_version = ">= 1.6"

  required_providers {
    github = {
      source  = "integrations/github"
      version = "~> 6.4"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}
