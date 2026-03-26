# DynamoDB table for ACP session-to-Slack-thread mappings
# PK: THREAD#{channel_id}:{root_thread_ts}
# On-demand capacity, TTL enabled (90 days from last activity)

resource "aws_dynamodb_table" "sessions" {
  name         = var.dynamodb_table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name = var.dynamodb_table_name
  }
}
