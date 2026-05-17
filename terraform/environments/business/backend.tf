# R2-Backend für business-State — gleiche R2-Bucket wie privat, anderer Key.

terraform {
  backend "s3" {
    bucket                      = "mcp-approval2-tf-state-eu"
    key                         = "business/terraform.tfstate"
    region                      = "auto"
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    use_path_style              = true
    # endpoints.s3 is supplied via TF_HTTP_BACKEND or AWS_ENDPOINT_URL_S3
    # (set by scripts/doppler-run-terraform.sh — same as privat).
  }
}
