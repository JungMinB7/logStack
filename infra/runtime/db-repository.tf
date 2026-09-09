locals {
  # Official Seoul AL2023 2023.12.20260831 mirror metadata, checked 2026-09-09.
  db_al2023_release    = "2023.12.20260831"
  db_repository_bucket = "al2023-repos-ap-northeast-2-de612dc2"
  db_repository_prefix = "core/guids/85f850e94b099c03219caec40bfba27b4d5a4f494da0cecd49502a9ad5cd201e/x86_64/"
  db_repository_url    = "https://${local.db_repository_bucket}.s3.dualstack.${local.region}.amazonaws.com/${local.db_repository_prefix}"
  db_repository_arns = [
    "arn:aws:s3:::${local.db_repository_bucket}/${local.db_repository_prefix}*",
    "arn:aws:s3:::${local.db_repository_bucket}/blobstore/*"
  ]
  db_packages = {
    postgresql16              = "16.15-1.amzn2023.0.1.x86_64"
    postgresql16-server       = "16.15-1.amzn2023.0.1.x86_64"
    postgresql16-private-libs = "16.15-1.amzn2023.0.1.x86_64"
    chrony                    = "4.3-1.amzn2023.0.6.x86_64"
    amazon-ssm-agent          = "3.3.4624.0-1.amzn2023.x86_64"
    awscli-2                  = "2.33.15-1.amzn2023.0.1.noarch"
  }
}
