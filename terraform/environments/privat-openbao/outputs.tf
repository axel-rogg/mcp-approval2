# Outputs — operative Hinweise.
#
# role_id + secret_id NICHT als TF-Output — die liegen schon in Doppler
# (siehe main.tf doppler_secret-Resources). Doppelte Belichtung würde nur
# das blast-radius vergrößern.

output "transit_mount" {
  description = "Pfad an dem die Transit-Engine gemountet ist (Bestätigung)."
  value       = vault_mount.transit.path
}

output "transit_key" {
  description = "Master-Key-Name in Transit. Sollte mit OPENBAO_TRANSIT_KEY in den Service-Configs übereinstimmen."
  value       = vault_transit_secret_backend_key.user_dek.name
}

output "approval2_role_name" {
  description = "Name der AppRole für approval2 — für manuelle bao-Commands beim Rotation-Workflow."
  value       = vault_approle_auth_backend_role.approval2.role_name
}

output "knowledge2_role_name" {
  description = "Name der AppRole für knowledge2."
  value       = vault_approle_auth_backend_role.knowledge2.role_name
}

output "rotation_command_approval2" {
  description = "One-liner zum manuellen Rotieren des secret_id für approval2. Ergebnis muss anschließend in Doppler eingetragen werden (oder `terraform apply -refresh-only`)."
  value       = "bao write -force -f auth/${vault_auth_backend.approle.path}/role/${vault_approle_auth_backend_role.approval2.role_name}/secret-id"
}

output "rotation_command_knowledge2" {
  description = "One-liner zum manuellen Rotieren des secret_id für knowledge2."
  value       = "bao write -force -f auth/${vault_auth_backend.approle.path}/role/${vault_approle_auth_backend_role.knowledge2.role_name}/secret-id"
}
