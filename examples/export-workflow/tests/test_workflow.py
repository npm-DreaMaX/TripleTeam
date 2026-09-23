"""Public, frozen acceptance checks for SPEC.md. Not a hidden benchmark."""
import unittest
from atlas import contracts, jobs
from atlas.api import dispatch
from atlas.client import ReportClient


class Workflow(unittest.TestCase):
    def setUp(self):
        self.rows = [{"name": "alpha", "value": 2}, {"name": "beta", "value": 3}]

    def create(self, key=None, rows=None):
        body = {"rows": self.rows if rows is None else rows}
        if key is not None:
            body["idempotency_key"] = key
        code, job = dispatch("POST", "/exports", body)
        self.assertEqual(code, 202)
        self.assertEqual(job["state"], "PENDING")
        self.assertEqual(job["progress"], 0)
        self.assertIsInstance(job["id"], str)
        return job

    def test_contract(self):
        self.assertEqual(set(contracts.EXPORT_STATES),
                         {"PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED"})

    def test_complete_and_download(self):
        job = self.create()
        jobs.process_pending()
        code, current = dispatch("GET", "/exports/" + job["id"])
        self.assertEqual(code, 200)
        self.assertEqual(current["state"], "SUCCEEDED")
        self.assertEqual(current["progress"], 100)
        self.assertEqual(dispatch("GET", "/exports/" + job["id"] + "/result"),
                         (200, {"csv": jobs.export_csv(self.rows)}))

    def test_cancel_is_terminal(self):
        job = self.create()
        route = "/exports/" + job["id"]
        self.assertEqual(dispatch("GET", route + "/result")[0], 409)
        self.assertEqual(dispatch("POST", route + "/cancel")[1]["state"], "CANCELLED")
        jobs.process_pending()
        self.assertEqual(dispatch("GET", route)[1]["state"], "CANCELLED")
        self.assertEqual(dispatch("GET", route + "/result")[0], 409)
        self.assertEqual(dispatch("POST", route + "/retry")[0], 409)

    def test_failure_then_retry(self):
        job = self.create()
        route = "/exports/" + job["id"]
        def fail(_rows):
            raise RuntimeError("temporary storage failure")
        jobs.process_pending(exporter=fail)
        self.assertEqual(dispatch("GET", route)[1]["state"], "FAILED")
        self.assertEqual(dispatch("POST", route + "/retry")[1]["state"], "PENDING")
        jobs.process_pending()
        self.assertEqual(dispatch("GET", route)[1]["state"], "SUCCEEDED")
        self.assertEqual(dispatch("POST", route + "/retry")[0], 409)

    def test_idempotency_and_input_validation(self):
        first = self.create("workflow-test-key")
        second = self.create("workflow-test-key")
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(dispatch("POST", "/exports", {"rows": [], "idempotency_key": "workflow-test-key"})[0], 409)
        for invalid in (None, ["not a row"], "bad"):
            self.assertEqual(dispatch("POST", "/exports", {"rows": invalid})[0], 400)
        self.assertEqual(dispatch("GET", "/exports/unknown-id")[0], 404)
        self.assertEqual(dispatch("POST", "/exports/unknown-id/cancel")[0], 404)

    def test_sdk_and_poll_limit(self):
        client = ReportClient(dispatch)
        job = client.start_export(self.rows)
        with self.assertRaises(TimeoutError):
            client.wait_export(job["id"], max_polls=2, interval=0)
        jobs.process_pending()
        self.assertEqual(client.wait_export(job["id"], max_polls=2, interval=0)["state"], "SUCCEEDED")
        self.assertEqual(client.download_export(job["id"]), jobs.export_csv(self.rows))
        pending = client.start_export([])
        self.assertEqual(client.cancel_export(pending["id"])["state"], "CANCELLED")
        with self.assertRaises(ValueError):
            client.retry_export(pending["id"])
