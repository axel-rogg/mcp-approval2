variable "project_name" {
  type        = string
  default     = "mcp-approval2"
  description = "Doppler-Project-Name (Single-Source-of-Truth fuer alle Secrets)."
}

variable "project_description" {
  type        = string
  default     = "Multi-User MCP-Approval-Server (Hetzner + GCP parallel)"
  description = "Beschreibung des Doppler-Projects (in der Doppler-UI sichtbar)."
}
