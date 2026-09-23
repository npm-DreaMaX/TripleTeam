"""Run after delivery: exercise the real HTTP boundary, worker and SDK together."""
import threading
from http.server import ThreadingHTTPServer

from atlas import jobs
from atlas.api import Handler
from atlas.client import ReportClient, http_transport


def main():
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    serving = threading.Thread(target=server.serve_forever, daemon=True)
    serving.start()
    stop = threading.Event()
    def tick():
        while not stop.wait(0.05):
            jobs.process_pending()
    worker = threading.Thread(target=tick, daemon=True)
    try:
        client = ReportClient(http_transport("http://127.0.0.1:" + str(server.server_port)))
        rows = [{"name": "Atlas", "rows": 120}, {"name": "Boreal", "rows": 80}]
        print("Atlas Reports · HTTP + SDK + background worker")
        print("Legacy export:", client.export(rows).strip())
        job = client.start_export(rows, idempotency_key="live-demo")
        print("Submitted:", job)
        worker.start()
        done = client.wait_export(job["id"], max_polls=200, interval=0.01)
        if done["state"] != "SUCCEEDED":
            raise RuntimeError(done)
        print("Completed:", done)
        print("Downloaded:\n" + client.download_export(job["id"]))
        print("Confirmed: asynchronous export crossed the actual HTTP boundary.")
    finally:
        stop.set()
        if worker.is_alive():
            worker.join(2)
        server.shutdown()
        server.server_close()
        serving.join(2)


if __name__ == "__main__":
    main()
