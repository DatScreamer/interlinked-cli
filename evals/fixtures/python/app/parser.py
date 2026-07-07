"""CSV-ish line parsing: split, clean, and assemble field values."""


def split_fields(line):
    """Split a raw line on commas (no quote awareness)."""
    return line.split(",")


def unquote(field):
    """Strip one pair of surrounding double quotes from a field, if present."""
    trimmed = field.strip()
    if len(trimmed) >= 2 and trimmed.startswith('"') and trimmed.endswith('"'):
        return trimmed[1:-1]
    return trimmed


def parse_row(line):
    """Parse one line into a list of clean field values."""
    return [unquote(field) for field in split_fields(line)]
