# IAM role with all project-relevant permissions (DynamoDB + CloudWatch Logs)
# Trusted by both the local development IAM user and EC2.

resource "aws_iam_role" "app" {
  name = "${var.project_name}-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowDeveloperAssumeRole"
        Effect = "Allow"
        Principal = {
          AWS = aws_iam_user.app.arn
        }
        Action = "sts:AssumeRole"
      },
      {
        Sid    = "AllowEc2AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "${var.project_name}-instance-profile"
  role = aws_iam_role.app.name
}

# DynamoDB access — scoped to the sessions table only
resource "aws_iam_role_policy" "dynamodb" {
  name = "${var.project_name}-dynamodb"
  role = aws_iam_role.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
          "dynamodb:DeleteItem",
          "dynamodb:Query"
        ]
        Resource = aws_dynamodb_table.sessions.arn
      }
    ]
  })
}

# CloudWatch Logs — scoped to the app log group
resource "aws_iam_role_policy" "cloudwatch_logs" {
  name = "${var.project_name}-cloudwatch-logs"
  role = aws_iam_role.app.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "WriteAppLogStreams"
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.app.arn}:*"
      },
      {
        Sid    = "DescribeLogStreams"
        Effect = "Allow"
        Action = [
          "logs:DescribeLogStreams"
        ]
        Resource = "*"
      }
    ]
  })
}

# -------------------------------------------------------------------
# IAM user — can ONLY assume the role above, nothing else
# -------------------------------------------------------------------

resource "aws_iam_user" "app" {
  name = "${var.project_name}-user"
}

resource "aws_iam_user_policy" "assume_role" {
  name = "${var.project_name}-assume-role"
  user = aws_iam_user.app.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "sts:AssumeRole"
        Resource = aws_iam_role.app.arn
      }
    ]
  })
}

# Access key for local development — store credentials securely
resource "aws_iam_access_key" "app" {
  user = aws_iam_user.app.name
}
