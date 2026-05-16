# Variables for the privat-openbao module.
#
# VAULT_ADDR + VAULT_TOKEN sind env-vars (vom vault-Provider direkt gelesen),
# NICHT Terraform-Variablen. Das hält den Token aus dem State raus.

variable "transit_mount_path" {
  type        = string
  default     = "transit"
  description = "Pfad an dem die Transit-Secrets-Engine gemountet wird. Muss mit OPENBAO_TRANSIT_PATH in den Service-Configs übereinstimmen (Default in src/adapters/kms/openbao.ts = 'transit')."
}

variable "approle_mount_path" {
  type        = string
  default     = "approle"
  description = "Pfad an dem die AppRole-Auth-Methode gemountet wird. Standard ist 'approle' — services lesen es nicht direkt, sondern verwenden role_id/secret_id."
}

variable "transit_key_name" {
  type        = string
  default     = "user-dek"
  description = "Name des Master-Keys in Transit, unter dem per-user DEKs abgeleitet werden. KC2's OpenBaoKms ruft datakey/plaintext/<user_id> auf — der Master-Key trägt den hier gesetzten Namen aber NICHT die user_ids (die werden per derived-key generiert)."
}

# --- Doppler-Pipe-Inputs (für secret_id-Distribution) ----------------------

variable "doppler_project_approval2" {
  type        = string
  default     = "mcp-approval2"
  description = "Doppler-Project-Name für approval2 (das Hauptmodul legt es an als doppler_project.mcp_approval2)."
}

variable "doppler_config_approval2" {
  type        = string
  default     = "privat"
  description = "Doppler-Config-Slug für die privat-Instanz von approval2."
}

variable "doppler_project_knowledge2" {
  type        = string
  default     = "mcp-knowledge2"
  description = "Doppler-Project-Name für knowledge2 (Hauptmodul legt es an als doppler_project.knowledge2)."
}

variable "doppler_config_knowledge2" {
  type        = string
  default     = "privat"
  description = "Doppler-Config-Slug für die privat-Instanz von knowledge2."
}

# --- Token-TTL-Knobs -------------------------------------------------------

variable "approle_token_ttl_seconds" {
  type        = number
  default     = 3600 # 1 h
  description = "TTL für AppRole-issued Tokens. Services renewen automatisch via /auth/token/renew-self; bei Service-Restart wird ein frischer Token via role_id+secret_id geholt."
}

variable "approle_token_max_ttl_seconds" {
  type        = number
  default     = 86400 # 24 h
  description = "Max-TTL — selbst mit Renew kann ein Token nicht länger leben. Bei Long-running-Worker → Service-Restart einplanen."
}

variable "secret_id_ttl_seconds" {
  type        = number
  default     = 7776000 # 90 days
  description = "TTL für secret_id selbst. Nach Ablauf muss ein neuer secret_id via `bao write -force auth/approle/role/<role>/secret-id` gemintet und in Doppler aktualisiert werden. Rotation-Cadence: vierteljährlich."
}
