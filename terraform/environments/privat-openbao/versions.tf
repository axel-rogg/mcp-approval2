# Provider-Requirements für das `privat-openbao`-Modul.
#
# vault-Provider ist OpenBao-kompatibel (Wire-Protocol identisch, OpenBao
# ist HashiCorp-Vault-Fork unter MPL-2.0). Tested gegen openbao 2.x +
# hashicorp/vault provider 5.x.

terraform {
  required_version = ">= 1.6"

  required_providers {
    vault = {
      source  = "hashicorp/vault"
      version = "~> 5.0"
    }
    doppler = {
      source  = "DopplerHQ/doppler"
      version = "~> 1.13"
    }
  }
}

# vault-Provider liest VAULT_ADDR + VAULT_TOKEN aus der Umgebung —
# explizit hier dokumentiert, kein hardcoded Wert.
provider "vault" {
  # address = aus env VAULT_ADDR (default http://127.0.0.1:8200, via fly proxy)
  # token   = aus env VAULT_TOKEN (Root-Token aus `bao operator init`)
  # WICHTIG: skip_child_token=true verhindert dass der Provider einen
  # ephemeren Child-Token mintet (Default-Verhalten würde root-token's TTL
  # vererben, was bei Root-Token = root-policy-Token = nicht ablaufend
  # unnötigerweise einen wrap-and-revoke-Cycle pro Apply triggert).
  skip_child_token = true
}

# doppler-Provider liest DOPPLER_TOKEN aus der Umgebung (workplace-scoped
# personal-token, derselbe wie für das `privat`-Modul).
provider "doppler" {
  # token = aus env DOPPLER_TOKEN
}
