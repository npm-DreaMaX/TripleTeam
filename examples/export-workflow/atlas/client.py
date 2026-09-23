"""SDK with injectable transport; no external service needed for testing."""
import json
import urllib.error
import urllib.request


def http_transport(base_url):
    def request(method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base_url + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)
    return request


class ReportClient:
    def __init__(self, transport):
        self.transport = transport

    def export(self, rows):
        status, body = self.transport("POST", "/export", {"rows": rows})
        if status != 200:
            raise ValueError(body.get("error", "export failed"))
        return body["csv"]
