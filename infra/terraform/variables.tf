variable "region" {
  type    = string
  default = "us-east-1"
}

variable "project" {
  type    = string
  default = "backstop"
}

variable "api_image" {
  type        = string
  description = "ECR image URI for the API (built from backend/Dockerfile)."
}

variable "ui_image" {
  type        = string
  description = "ECR image URI for the UI gateway (built from frontend/Dockerfile)."
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  type        = list(string)
  description = "Subnets for the tasks and the database. They need a NAT gateway or VPC endpoints (ECR, Secrets Manager, CloudWatch Logs, S3) to pull images and read secrets."
}

variable "public_subnet_ids" {
  type = list(string)
}

variable "certificate_arn" {
  type        = string
  description = "ACM certificate for the HTTPS listener. Plain HTTP only redirects."
}

variable "allowed_ingress_cidrs" {
  type        = list(string)
  description = "Who may reach the load balancer: EIP's office and VPN egress ranges. Never 0.0.0.0/0 for a system that can hold call transcripts."

  validation {
    condition     = length(var.allowed_ingress_cidrs) > 0 && !contains(var.allowed_ingress_cidrs, "0.0.0.0/0")
    error_message = "List at least one CIDR, and not 0.0.0.0/0."
  }
}

variable "db_password" {
  type      = string
  sensitive = true
}

variable "backstop_users" {
  type        = string
  sensitive   = true
  description = "BACKSTOP_USERS (name:password:role,...). Stored in Secrets Manager; replace with SSO before real use."
}

variable "enable_model_key" {
  type        = bool
  default     = false
  description = "Create the model-provider secret. Kept separate from the key itself because a sensitive value cannot drive count."
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "nightly_model" {
  type        = string
  default     = "sim-large"
  description = "Model the nightly gate runs. Set to the production model id once one is chosen."
}

variable "alert_email" {
  type        = string
  default     = ""
  description = "Subscribed to the alert topic when set (confirm the subscription email)."
}
