locals {
  # T5 runtime-only secret retrieval. These are names/ARNs, never values.
  db_parameter_arns = [var.db.migration_secret_arn, var.db.application_secret_arn]
  # Minimal modern SSM Agent Session Manager foundation, not full managed-core parity.
  ssm_actions = ["ssm:UpdateInstanceInformation"]
  channel_actions = [
    "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"
  ]
}

resource "aws_iam_role_policy" "db_parameters" {
  name = "${local.name}-db-parameters"
  role = aws_iam_role.ec2["db"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["ssm:GetParameter"]
      Resource = local.db_parameter_arns
    }]
  })
}

resource "aws_iam_role" "ec2" {
  for_each = local.ec2_roles
  name     = "${local.name}-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
  tags = { Name = "${local.name}-${each.key}" }
}

resource "aws_iam_role_policy" "management" {
  for_each = local.ec2_roles
  name     = "session-manager-channels"
  role     = aws_iam_role.ec2[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = concat(local.ssm_actions, local.channel_actions)
      Resource = "*"
    }]
  })
}

resource "aws_iam_instance_profile" "ec2" {
  for_each = local.ec2_roles
  name     = "${local.name}-${each.key}"
  role     = aws_iam_role.ec2[each.key].name
  tags     = { Name = "${local.name}-${each.key}" }
}

resource "aws_iam_role_policy" "s3_read" {
  for_each = toset(flatten([for grant in values(var.s3_read_paths) : tolist(grant.roles)]))
  name     = "approved-s3-read-paths"
  role     = aws_iam_role.ec2[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [for grant in values(var.s3_read_paths) : {
      Effect   = "Allow"
      Action   = ["s3:GetObject"]
      Resource = "arn:aws:s3:::${grant.bucket}/${grant.prefix}*"
    } if contains(grant.roles, each.key)]
  })
}
