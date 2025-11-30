variable "worker_ids" {
  description = "Lista de instance IDs (ej. [\"i-0abc...\", \"i-0def...\"]) a importar desde la cuenta externa"
  type        = list(string)
  default     = []
}

variable "boletas_bucket_name" {
  description = "Nombre del bucket S3 que contiene las boletas en la cuenta externa"
  type        = string
}

variable "env" {
  description = "Environment name"
  type        = string
}

