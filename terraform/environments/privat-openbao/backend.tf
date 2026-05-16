# Separate State für OpenBao-Konfiguration.
#
# Eigenes State-File weil:
#   - Apply-Sequencing: dieses Modul kann erst nach `bao operator init`
#     laufen (braucht VAULT_TOKEN im env), während das Haupt-`privat`-Modul
#     vorher idempotent appliebar ist.
#   - Provider-Isolation: vault-Provider scheitert hart wenn OpenBao nicht
#     erreichbar ist — würde sonst alle plan/apply-Calls im Hauptstate
#     blocken.
#   - State-Sensitivität: AppRole-secret_ids landen hier; bewusst separater
#     blast-radius.
#
# Root-Backend-Settings (R2-EU) werden aus ../../backend.tf geerbt; nur der
# `key` differiert.

terraform {
  backend "s3" {
    bucket = "terraform-state"
    key    = "mcp-approval2/privat-openbao/terraform.tfstate"
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
