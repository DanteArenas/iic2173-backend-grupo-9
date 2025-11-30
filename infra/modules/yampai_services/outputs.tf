
output "worker_ids" {
  # Prefer returning the actual resource IDs of the imported/managed EC2 instances
  # If the variable `worker_ids` is provided (non-empty), use it as fallback.
  value = length(var.worker_ids) > 0 ? var.worker_ids : [aws_instance.worker_i_03d284aaa415f72b7.id]
}

output "boletas_bucket_name" {
  value = var.boletas_bucket_name
}

