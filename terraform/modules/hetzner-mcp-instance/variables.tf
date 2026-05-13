variable "instance_name" {
  type        = string
  description = "Short identifier for the instance (e.g. 'privat', 'business'). Used as name-prefix + label."

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.instance_name))
    error_message = "instance_name must be lowercase alnum/dash, start with a letter, 2-31 chars."
  }
}

variable "environment" {
  type        = string
  description = "Environment label for tagging (privat | business)."
}

variable "server_type" {
  type        = string
  default     = "cx21"
  description = "Hetzner server type. cx21 = 4 vCPU / 8 GB RAM, ~6 EUR/Mo as of 2026-05."
}

variable "location" {
  type        = string
  default     = "fsn1"
  description = "Hetzner location (fsn1 = Frankfurt, nbg1 = Nuernberg, hel1 = Helsinki)."
}

variable "operator_ssh_public_key" {
  type        = string
  description = "OpenSSH public key (single line, e.g. 'ssh-ed25519 AAAA... operator@host') for VM access."
  sensitive   = false
}

variable "allowed_ssh_ips" {
  type        = list(string)
  default     = ["0.0.0.0/0", "::/0"]
  description = "CIDR list allowed to reach port 22. Production should restrict to operator IPs."
}

variable "data_volume_size_gb" {
  type        = number
  default     = 0
  description = "If > 0, attach an extra Hetzner volume of this size (GB) for persistent data (pgdata, R2-cache, etc.). Disabled by default."

  validation {
    condition     = var.data_volume_size_gb >= 0 && var.data_volume_size_gb <= 10240
    error_message = "data_volume_size_gb must be between 0 (disabled) and 10240 (10 TiB)."
  }
}
