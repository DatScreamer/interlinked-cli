"""Record validation helpers."""


def is_valid_record(row):
    """A record is valid when it has at least two non-empty fields."""
    non_empty = [field for field in row if field]
    return len(non_empty) >= 2
