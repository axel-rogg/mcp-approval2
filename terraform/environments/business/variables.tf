variable "gcp_project_id" {
  type        = string
  description = "GCP Project ID — z.B. firma-knowledge-prod."
}

variable "gcp_region" {
  type        = string
  description = "GCP Region — z.B. europe-west4 (Frankfurt) für DSGVO-Posture."
  default     = "europe-west4"
}

variable "cloudflare_zone_id" {
  type        = string
  description = "CF-Zone-ID für die business-Subdomain (falls AI Gateway / DNS via CF bleibt)."
}

variable "cloudflare_api_token" {
  type        = string
  description = "CF-API-Token (Workers AI Read + AI Gateway Run + DNS Edit)."
  sensitive   = true
}

variable "domain_knowledge" {
  type        = string
  description = "FQDN für mcp-knowledge2 in business — z.B. knowledge.firma.com"
}

variable "container_image" {
  type        = string
  description = "Container-Image für Cloud Run (z.B. europe-west4-docker.pkg.dev/proj/img:tag)."
  default     = "ghcr.io/axel-rogg/mcp-knowledge2:latest"
}
