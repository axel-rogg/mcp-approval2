# Variables declared for Phase 2. The module currently produces no resources,
# so these are effectively documentation of the target API.

variable "instance_name" {
  type        = string
  description = "Identifier (e.g. 'business'). Used in resource naming."
  default     = "business"
}

variable "environment" {
  type        = string
  description = "Environment label (business)."
  default     = "business"
}

variable "gcp_project_id" {
  type        = string
  description = "GCP project ID hosting Cloud Run + Cloud SQL."
  default     = ""
}

variable "gcp_region" {
  type        = string
  description = "GCP region for Cloud Run / Cloud SQL (e.g. europe-west3)."
  default     = "europe-west3"
}

variable "container_image_mcp" {
  type        = string
  description = "Fully-qualified Artifact Registry path for the mcp-approval2 container."
  default     = ""
}

variable "container_image_knowledge" {
  type        = string
  description = "Fully-qualified Artifact Registry path for the mcp-knowledge2 container."
  default     = ""
}

variable "cloud_sql_tier" {
  type        = string
  description = "Cloud SQL machine tier (e.g. db-f1-micro, db-custom-1-3840)."
  default     = "db-f1-micro"
}
