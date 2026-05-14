terraform {
  required_version = ">= 1.6"

  required_providers {
    doppler = {
      source  = "DopplerHQ/doppler"
      version = "~> 1.13"
    }
  }
}
