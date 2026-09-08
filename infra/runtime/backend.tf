terraform {
  backend "s3" {
    encrypt      = true
    use_lockfile = true
    # bucket/key/region/allowed_account_ids are mandatory operator backend inputs.
  }
}
