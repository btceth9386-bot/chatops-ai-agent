# CloudWatch Log Group for Slack Bot, Cronjobs, and error logging

resource "aws_cloudwatch_log_group" "app" {
  name              = var.cloudwatch_log_group_name
  retention_in_days = var.cloudwatch_log_retention_days

  tags = {
    Name = var.cloudwatch_log_group_name
  }
}
