locals {
  # Minimal modern SSM Agent Session Manager foundation, not full managed-core parity.
  ssm_actions = ["ssm:UpdateInstanceInformation"]
  channel_actions = [
    "ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel",
    "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"
  ]
}

resource "aws_iam_role" "ec2" {
  for_each = local.ec2_roles
  name     = "${local.name}-${each.key}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Action = "sts:AssumeRole"
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
  for_each = local.s3_roles
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
