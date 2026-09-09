resource "aws_iam_role" "db_snapshots" {
  name = "${local.name}-db-snapshots"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow", Action = "sts:AssumeRole", Principal = { Service = "dlm.amazonaws.com" }
      Condition = {
        StringEquals = { "aws:SourceAccount" = var.aws_account_id }
        ArnLike      = { "aws:SourceArn" = "arn:aws:dlm:${local.region}:${var.aws_account_id}:policy/*" }
      }
    }]
  })
  tags = { Name = "${local.name}-db-snapshots" }
}

resource "aws_iam_role_policy" "db_snapshots" {
  name = "daily-three-data-volume-snapshots"
  role = aws_iam_role.db_snapshots.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DiscoverRegionalVolumeSnapshots", Effect = "Allow"
        Action    = ["ec2:DescribeVolumes", "ec2:DescribeSnapshots", "ec2:DescribeTags"]
        Resource  = "*"
        Condition = { StringEquals = { "aws:RequestedRegion" = local.region } }
      },
      {
        Sid    = "SnapshotOnlyApprovedDataVolume", Effect = "Allow"
        Action = ["ec2:CreateSnapshot"], Resource = aws_ebs_volume.db_data.arn
      },
      {
        Sid       = "CreateSnapshotForExactParentVolume", Effect = "Allow"
        Action    = ["ec2:CreateSnapshot"], Resource = "arn:aws:ec2:${local.region}::snapshot/*"
        Condition = { ArnEquals = { "ec2:ParentVolume" = aws_ebs_volume.db_data.arn } }
      },
      {
        # DLM docs do not guarantee atomic tagging vs a later CreateTags call.
        # Allow both only on this owned parent-volume snapshot lineage.
        Sid    = "TagOnlyOwnedDataVolumeSnapshots", Effect = "Allow"
        Action = ["ec2:CreateTags"], Resource = "arn:aws:ec2:${local.region}::snapshot/*"
        Condition = {
          ArnEquals    = { "ec2:ParentVolume" = aws_ebs_volume.db_data.arn }
          StringEquals = { "ec2:Owner" = var.aws_account_id }
        }
      },
      {
        Sid    = "RetainOnlyThisOwnedBackupSet", Effect = "Allow"
        Action = ["ec2:DeleteSnapshot"], Resource = "arn:aws:ec2:${local.region}::snapshot/*"
        Condition = {
          ArnEquals = { "ec2:ParentVolume" = aws_ebs_volume.db_data.arn }
          StringEquals = {
            "ec2:Owner"                    = var.aws_account_id
            "ec2:ResourceTag/BackupPolicy" = local.db_snapshot_policy
            "ec2:ResourceTag/Project"      = var.project
          }
        }
      }
    ]
  })
}

resource "aws_dlm_lifecycle_policy" "db_data" {
  description        = "Daily logStack PostgreSQL data volume snapshots retain three"
  execution_role_arn = aws_iam_role.db_snapshots.arn
  state              = "ENABLED"
  policy_details {
    resource_types = ["VOLUME"]
    target_tags    = { BackupPolicy = local.db_snapshot_policy }
    schedule {
      name      = "daily-data-03-utc"
      copy_tags = false
      create_rule {
        interval      = 24
        interval_unit = "HOURS"
        times         = ["03:00"]
      }
      retain_rule { count = 3 }
      tags_to_add = { Project = var.project, Environment = var.environment, BackupPolicy = local.db_snapshot_policy }
    }
  }
  tags       = { Name = "${local.name}-db-daily" }
  depends_on = [aws_iam_role_policy.db_snapshots]
}

output "database_snapshot_policy" {
  value = {
    policy_id        = aws_dlm_lifecycle_policy.db_data.id, role_arn = aws_iam_role.db_snapshots.arn,
    source_volume_id = aws_ebs_volume.db_data.id, schedule_utc = "03:00", retained_count = 3
  }
}
