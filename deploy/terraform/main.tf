terraform {
  required_version = ">= 1.6"
  required_providers {
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.35" }
    helm       = { source = "hashicorp/helm", version = "~> 2.17" }
    random     = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "kubernetes" {
  config_path    = var.kubeconfig
  config_context = var.kube_context
}

provider "helm" {
  kubernetes {
    config_path    = var.kubeconfig
    config_context = var.kube_context
  }
}

# Keys are generated, never typed into a file. They live in Terraform state, so keep
# the state in a backend that is encrypted and locked down.
resource "random_password" "admin" {
  length  = 40
  special = false
}

resource "random_password" "api_key" {
  for_each = toset(var.accounts)
  length   = 32
  special  = false
}

resource "kubernetes_namespace_v1" "this" {
  metadata {
    name = var.namespace
    labels = {
      "app.kubernetes.io/part-of"          = "ledgerforge"
      "pod-security.kubernetes.io/enforce" = "restricted"
    }
  }
}

# The database and broker URLs go into a Secret that Terraform owns, so the chart
# never sees them in its values.
resource "kubernetes_secret_v1" "config" {
  metadata {
    name      = "ledgerforge-config"
    namespace = kubernetes_namespace_v1.this.metadata[0].name
  }
  data = {
    accountsDatabaseUrl = var.accounts_database_url
    ledgerDatabaseUrl   = var.ledger_database_url
    redisUrl            = var.redis_url
    amqpUrl             = var.amqp_url
    apiKeys             = join(",", [for a in var.accounts : "${random_password.api_key[a].result}:${a}"])
    adminKey            = random_password.admin.result
  }
}

resource "helm_release" "ledgerforge" {
  name             = "ledgerforge"
  namespace        = kubernetes_namespace_v1.this.metadata[0].name
  chart            = "${path.module}/../helm/ledgerforge"
  atomic           = true
  wait             = true
  timeout          = 300
  create_namespace = false

  values = [yamlencode({
    existingSecret = kubernetes_secret_v1.config.metadata[0].name
    image          = { repository = var.image_repository, tag = var.image_tag }
    symbols        = join(",", var.symbols)
    otlpEndpoint   = var.otlp_endpoint
    gateway = {
      replicas = var.gateway_replicas
      ingress  = { enabled = var.ingress_host != "", host = var.ingress_host, className = var.ingress_class }
    }
  })]
}
