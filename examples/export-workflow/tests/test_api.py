import unittest
from atlas.api import dispatch


class API(unittest.TestCase):
    def test_legacy_api(self):
        self.assertEqual(dispatch("POST", "/export", {"rows": [{"a": 1}]}),
                         (200, {"csv": "a\n1\n"}))
        self.assertEqual(dispatch("POST", "/export", {"rows": None})[0], 400)
        self.assertEqual(dispatch("GET", "/missing")[0], 404)
