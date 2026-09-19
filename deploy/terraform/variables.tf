variable "kubeconfig" {
  type    = string
  default = "~/.kube/config"
}

variable "kube_context" {
  type    = string
  default = null
}

variable "namespace" {
  type    = string
  default = "ledgerforge"
}

variable "image_repository" {
  type        = string
  description = "Registry path of the ledgerforge image"
  default     = "ledgerforge"
}

variable "image_tag" {
  type    = string
  default = "dev"
}

variable "accounts" {
  type        = list(string)
  description = "Account ids that get an API key. One key is generated per account."
  default     = ["alice", "bob"]
}

variable "symbols" {
  type    = list(string)
  default = ["BTC-USD", "ETH-USD"]
}

variable "gateway_replicas" {
  type    = number
  default = 2
}

variable "otlp_endpoint" {
  type        = string
  description = "OTLP/HTTP endpoint for traces, empty to switch tracing off"
  default     = ""
}

variable "ingress_host" {
  type        = string
  description = "Public host name for the gateway, empty for no ingress"
  default     = ""
}

variable "ingress_class" {
  type    = string
  default = ""
}

variable "accounts_database_url" {
  type      = string
  sensitive = true
}

variable "ledger_database_url" {
  type      = string
  sensitive = true
}

variable "redis_url" {
  type      = string
  sensitive = true
}

variable "amqp_url" {
  type      = string
  sensitive = true
}
