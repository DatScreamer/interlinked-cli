from app.parser import parse_row, unquote


def test_unquote_strips_surrounding_quotes():
    assert unquote('"hello"') == "hello"


def test_unquote_leaves_bare_fields_alone():
    assert unquote("plain") == "plain"


def test_parse_row_splits_and_cleans():
    assert parse_row('a,"b",c') == ["a", "b", "c"]
