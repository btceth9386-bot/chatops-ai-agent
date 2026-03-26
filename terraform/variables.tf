variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment name (e.g., prod, staging)"
  type        = string
  default     = "prod"
}

variable "project_name" {
  description = "Project name used for resource naming"
  type        = string
  default     = "chatops-ai-agent"
}

# --- DynamoDB ---

variable "dynamodb_table_name" {
  description = "DynamoDB table name for ACP session persistence"
  type        = string
  default     = "slack-kiro-sessions"
}

# --- CloudWatch ---

variable "cloudwatch_log_group_name" {
  description = "CloudWatch Log Group name for bot and cronjob logs"
  type        = string
  default     = "/chatops-ai-agent/app"
}

variable "cloudwatch_log_retention_days" {
  description = "Log retention in days"
  type        = number
  default     = 90
}
