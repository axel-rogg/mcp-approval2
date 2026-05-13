# Required providers for this module.
#
# Modules must declare their own required_providers block; the root-level
# versions.tf only documents the user-facing surface. The `source` here
# pins us to hetznercloud/hcloud (the registry path Terraform v1.x resolves
# to). Version constraint inherits from environments/*/versions.tf.

terraform {
  required_version = ">= 1.6"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.48"
    }
  }
}
