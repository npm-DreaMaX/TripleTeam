"""JSON transport boundary; usable in-process and through HTTP."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .jobs import export_csv


def dispatch(method, path, body=None):
    if method == "POST" and path == "/export":
        try:
            return 200, {"csv": export_csv((body or {}).get("rows"))}
        except (ValueError, TypeError):
            return 400, {"error": "invalid rows"}
    return 404, {"error": "not found"}


class Handler(BaseHTTPRequestHandler):
    def respond(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length)) if length else None
            status, payload = dispatch(self.command, self.path, body)
        except (ValueError, TypeError):
            status, payload = 400, {"error": "invalid JSON"}
        encoded = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    do_GET = respond
    do_POST = respond


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", 8080), Handler).serve_forever()
