"""File loading helpers built on top of the parser."""

from .parser import parse_row


def load_records(path):
    """Read a file and parse every non-empty line into a row."""
    with open(path, encoding="utf-8") as handle:
        return [parse_row(line) for line in handle if line.strip()]
