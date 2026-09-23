"""Shared public report format. Keep this interface compatible."""


def validate_rows(rows):
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ValueError("rows must be a list of objects")
    return rows
