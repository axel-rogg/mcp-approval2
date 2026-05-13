# Backend override for the `privat` workspace.
#
# We can't use Terraform workspaces (`terraform workspace`) here because the
# directory-per-environment pattern is clearer for multi-cloud setups —
# different environments use different providers (Hetzner vs. GCP) so they
# need separate `.terraform/` plugin caches anyway.
#
# Other backend settings (bucket, endpoints, region, skip_*) are inherited
# from ../../backend.tf at the root. Only `key` differs per environment.

terraform {
  backend "s3" {
    bucket = "terraform-state"
    key    = "mcp-approval2/privat/terraform.tfstate"
    endpoints = {
      s3 = "https://6a005d3b67fcb0637fd5917cb5280ce1.eu.r2.cloudflarestorage.com"
    }
    region = "auto"

    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}
