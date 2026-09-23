import unittest
from atlas.jobs import export_csv


class Jobs(unittest.TestCase):
    def test_legacy_csv(self):
        self.assertEqual(export_csv([{"b": 2, "a": "x,y"}, {"a": "z"}]),
                         'a,b\n"x,y",2\nz,\n')
        self.assertEqual(export_csv([]), "")
