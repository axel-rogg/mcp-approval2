# R2-Backend for Terraform-State.
#
# Same R2 account / bucket as mcp-approval/terraform/. Each environment
# overrides the `key` in environments/<name>/backend.tf so workspaces
# don't share state.
#
# Required env (all in .env / .dev.vars):
#   AWS_ACCESS_KEY_ID        — R2 access key id (treated as S3 key id)
#   AWS_SECRET_ACCESS_KEY    — R2 secret access key
#   R2_ENDPOINT              — full https://<account>.eu.r2.cloudflarestorage.com URL
#
# Endpoint is fixed here because Terraform's S3 backend doesn't expand env vars
# in the `endpoints` block. If you ever rotate R2 accounts, update the URL.

terraform {
  backend "s3" {
    bucket = "terraform-state"
    key    = "mcp-approval2/terraform.tfstate" # override per environment
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
