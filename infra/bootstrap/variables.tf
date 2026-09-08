variable "aws_account_id" {
  description = "Human-approved deployment account ID; credentials use the external AWS credential chain."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "Provide the approved 12-digit account ID."
  }
}

variable "project" {
  type    = string
  default = "logstack-demo"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,29}$", var.project))
    error_message = "Project must be 2-30 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "environment" {
  type    = string
  default = "demo"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.environment))
    error_message = "Environment must be 2-20 lowercase letters, digits or hyphens, starting with a letter."
  }
}

variable "state_bucket_name" {
  description = "Approved globally unique NEW bucket name. Do not point bootstrap at an existing bucket."
  type        = string
  nullable    = false
  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$", var.state_bucket_name))
    error_message = "Use a valid 3-63 character lowercase bucket name without dots."
  }
}
