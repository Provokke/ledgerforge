output "namespace" {
  value = kubernetes_namespace_v1.this.metadata[0].name
}

output "gateway_service" {
  value = "ledgerforge-gateway.${kubernetes_namespace_v1.this.metadata[0].name}.svc:3000"
}

output "api_keys" {
  description = "Generated API key for each account"
  value       = { for a in var.accounts : a => random_password.api_key[a].result }
  sensitive   = true
}

output "admin_key" {
  value     = random_password.admin.result
  sensitive = true
}
