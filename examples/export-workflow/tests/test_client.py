import unittest
from atlas.api import dispatch
from atlas.client import ReportClient


class Client(unittest.TestCase):
    def test_legacy_sdk(self):
        self.assertEqual(ReportClient(dispatch).export([{"a": 1}]), "a\n1\n")
        with self.assertRaises(ValueError):
            ReportClient(dispatch).export(None)
