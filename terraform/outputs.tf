output "dynamodb_table_name" {
  description = "DynamoDB session table name"
  value       = aws_dynamodb_table.sessions.name
}

output "dynamodb_table_arn" {
  description = "DynamoDB session table ARN"
  value       = aws_dynamodb_table.sessions.arn
}

output "cloudwatch_log_group_name" {
  description = "CloudWatch Log Group name"
  value       = aws_cloudwatch_log_group.app.name
}

output "cloudwatch_log_group_arn" {
  description = "CloudWatch Log Group ARN"
  value       = aws_cloudwatch_log_group.app.arn
}

output "iam_role_arn" {
  description = "IAM role ARN (assume this role to get DynamoDB + CloudWatch permissions)"
  value       = aws_iam_role.app.arn
}

output "iam_instance_profile_name" {
  description = "EC2 instance profile name for attaching the app role to an instance"
  value       = aws_iam_instance_profile.app.name
}

output "iam_instance_profile_arn" {
  description = "EC2 instance profile ARN"
  value       = aws_iam_instance_profile.app.arn
}

output "iam_user_name" {
  description = "IAM user name (has assume-role permission only)"
  value       = aws_iam_user.app.name
}

output "iam_user_access_key_id" {
  description = "IAM user access key ID for local development"
  value       = aws_iam_access_key.app.id
}

output "iam_user_secret_access_key" {
  description = "IAM user secret access key — store securely"
  value       = aws_iam_access_key.app.secret
  sensitive   = true
}
