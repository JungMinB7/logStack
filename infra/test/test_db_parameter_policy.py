"""Offline regression checks for the intentionally small DB-only SSM grant.

These source-contract checks supplement validate/independent review; they are
not an AWS authorization simulator or evidence of successful secret retrieval.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1] / 'runtime'


class ParameterPolicyTests(unittest.TestCase):
    def test_identity_policy_exact_single_read_and_db_role(self):
        source = (ROOT / 'iam.tf').read_text()
        block = source.split('resource "aws_iam_role_policy" "db_parameters" {', 1)[1].split('\nresource ', 1)[0]
        self.assertRegex(block, r'role\s*=\s*aws_iam_role\.ec2\["db"\]\.id')
        self.assertRegex(block, r'Action\s*=\s*\["ssm:GetParameter"\]')
        self.assertRegex(block, r'Resource\s*=\s*local\.db_parameter_arns')
        self.assertNotIn('receiver', block)
        self.assertNotIn('kms:', block)
        self.assertNotIn('"*"', block)

    def test_two_exact_arn_variables_shared_by_iam_and_endpoint(self):
        iam = (ROOT / 'iam.tf').read_text()
        endpoint = (ROOT / 'endpoints.tf').read_text()
        self.assertRegex(iam, r'db_parameter_arns\s*=\s*\[var\.db\.migration_secret_arn, var\.db\.application_secret_arn\]')
        statement = endpoint.split('Action = ["ssm:GetParameter"]', 1)[1].split('}]', 1)[0]
        self.assertIn('Resource = local.db_parameter_arns', statement)
        self.assertIn('"aws:PrincipalArn" = aws_iam_role.ec2["db"].arn', statement)
        self.assertNotIn('local.role_arns', statement)
        self.assertNotIn('receiver', statement)

    def test_no_parameter_value_source_or_write_permissions(self):
        source = '\n'.join(p.read_text() for p in ROOT.glob('*.tf'))
        self.assertNotRegex(source, r'(?:data|resource)\s+"aws_ssm_parameter')
        for action in ('ssm:GetParameters', 'ssm:GetParametersByPath', 'ssm:PutParameter', 'ssm:GetParameterHistory'):
            self.assertNotIn('"' + action + '"', source)


if __name__ == '__main__': unittest.main()
