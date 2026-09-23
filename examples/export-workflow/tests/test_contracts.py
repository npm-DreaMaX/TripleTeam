import unittest
from atlas.contracts import validate_rows


class Contracts(unittest.TestCase):
    def test_rows(self):
        self.assertEqual(validate_rows([]), [])
        self.assertEqual(validate_rows([{"a": 1}]), [{"a": 1}])
        for invalid in (None, "bad", [1], {}):
            with self.assertRaises(ValueError):
                validate_rows(invalid)
