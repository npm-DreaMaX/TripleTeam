"""Existing synchronous report generation."""
import csv
import io

from .contracts import validate_rows


def export_csv(rows):
    rows = validate_rows(rows)
    if not rows:
        return ""
    columns = sorted({key for row in rows for key in row})
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    writer.writerows(rows)
    return output.getvalue()
