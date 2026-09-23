import threading
import unittest
from atlas import jobs
from atlas.api import dispatch


class Concurrency(unittest.TestCase):
    def test_cancellation_wins_inflight_work(self):
        code, job = dispatch("POST", "/exports", {"rows": [{"a": 1}]})
        self.assertEqual(code, 202)
        entered, released = threading.Event(), threading.Event()
        def slow(rows):
            entered.set()
            if not released.wait(3):
                raise RuntimeError("test synchronization timed out")
            return jobs.export_csv(rows)
        worker = threading.Thread(target=lambda: jobs.process_pending(exporter=slow), daemon=True)
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            outcome = []
            cancel = threading.Thread(target=lambda: outcome.append(dispatch("POST", "/exports/" + job["id"] + "/cancel")), daemon=True)
            cancel.start()
            cancel.join(1)
            self.assertFalse(cancel.is_alive(), "store lock is held across exporter execution")
            self.assertEqual(outcome[0][1]["state"], "CANCELLED")
        finally:
            released.set()
            worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(dispatch("GET", "/exports/" + job["id"])[1]["state"], "CANCELLED")

    def test_snapshots_and_inputs_are_copied(self):
        rows = [{"a": "original"}]
        code, job = dispatch("POST", "/exports", {"rows": rows})
        self.assertEqual(code, 202)
        identity = job["id"]
        rows[0]["a"] = "changed"
        job["state"] = "CANCELLED"
        jobs.process_pending()
        self.assertEqual(dispatch("GET", "/exports/" + identity + "/result"),
                         (200, {"csv": "a\noriginal\n"}))
