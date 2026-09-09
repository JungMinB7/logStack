locals {
  db_backup_bucket_name = "logstack-db-backup-${var.aws_account_id}-${local.region}"
  db_backup_prefix      = "pg-dump/"
  db_snapshot_policy    = "${local.name}-db-daily"
  db_backup_config = {
    approved     = true
    bucket       = local.db_backup_bucket_name
    bucket_owner = var.aws_account_id
    prefix       = local.db_backup_prefix
    encryption   = "AES256"
  }
}

resource "aws_s3_bucket" "db_backup" {
  bucket        = local.db_backup_bucket_name
  force_destroy = false
  tags          = { Name = local.db_backup_bucket_name, DataRole = "pg-dump" }
  lifecycle { prevent_destroy = true }
}

resource "aws_s3_bucket_public_access_block" "db_backup" {
  bucket                  = aws_s3_bucket.db_backup.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "db_backup" {
  bucket = aws_s3_bucket.db_backup.id
  rule { object_ownership = "BucketOwnerEnforced" }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "db_backup" {
  bucket = aws_s3_bucket.db_backup.id
  rule {
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "db_backup" {
  bucket = aws_s3_bucket.db_backup.id
  rule {
    id     = "approved-seven-day-dumps"
    status = "Enabled"
    filter { prefix = local.db_backup_prefix }
    expiration { days = 7 }
    abort_incomplete_multipart_upload { days_after_initiation = 1 }
  }
}

resource "aws_s3_bucket_policy" "db_backup" {
  bucket = aws_s3_bucket.db_backup.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport", Effect = "Deny", Principal = "*", Action = "s3:*"
      Resource  = [aws_s3_bucket.db_backup.arn, "${aws_s3_bucket.db_backup.arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
      }, {
      Sid       = "RequireExplicitSSES3", Effect = "Deny", Principal = "*", Action = "s3:PutObject"
      Resource  = "${aws_s3_bucket.db_backup.arn}/${local.db_backup_prefix}*"
      Condition = { StringNotEquals = { "s3:x-amz-server-side-encryption" = "AES256" } }
    }]
  })
}

resource "aws_iam_role_policy" "db_backup" {
  name = "${local.name}-db-backup-write"
  role = aws_iam_role.ec2["db"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow", Action = ["s3:PutObject"]
      Resource  = "${aws_s3_bucket.db_backup.arn}/${local.db_backup_prefix}*"
      Condition = { StringEquals = { "s3:x-amz-server-side-encryption" = "AES256" } }
    }]
  })
}

output "database_backups" {
  description = "Approved daily dump destination and lifecycle contract; not restore evidence."
  value = {
    bucket         = aws_s3_bucket.db_backup.id, prefix = local.db_backup_prefix,
    retention_days = 7, dump_schedule_utc = "02:00", snapshot_retained_count = 3
  }
}
