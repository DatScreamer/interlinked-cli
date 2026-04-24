#!/usr/bin/env python3
"""Long-running sidecar for OpenAI's privacy-filter (OPF).

Reads JSONL requests from stdin, writes JSONL responses to stdout. One `OPF`
instance is constructed at startup and reused for the process lifetime so the
multi-second model load amortizes across many scan requests.

Protocol mirrors `src/harness/content-scanner/sidecar-manager.ts`:

  request:   {"id": "<id>", "op": "ping" | "scan" | "shutdown", "text"?: str}
  response:  {"id": "<id>", "ok": true | false,
              "spans"?: [{"label": str, "start": int, "end": int, "text": str}],
              "redacted_text"?: str, "error"?: str}

Prereq: `pip install opf`. If the import fails (package missing, wrong venv),
the sidecar emits one init-failure line and exits — the TS-side manager
treats that as fail-open and disables the scanner for the session.
"""

from __future__ import annotations

import json
import sys
import traceback
from typing import Any


def _write(obj: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _ok(req_id: str | None, payload: dict[str, Any]) -> None:
    _write({"id": req_id, "ok": True, **payload})


def _fail(req_id: str | None, msg: str) -> None:
    _write({"id": req_id, "ok": False, "error": msg})


def _build_opf() -> Any:
    try:
        from opf import OPF  # type: ignore[import-not-found]
    except ImportError as e:
        _fail(None, f"opf not installed: {e}. Run `pip install opf` in this interpreter.")
        sys.exit(2)

    try:
        # CPU-only; macOS lacks MPS support in the shipped OPF runtime.
        return OPF(device="cpu")
    except Exception as e:
        _fail(None, f"OPF init failed: {e}\n{traceback.format_exc()}")
        sys.exit(3)


def _handle_scan(opf: Any, req_id: str | None, text: Any) -> None:
    if not isinstance(text, str):
        _fail(req_id, "scan `text` must be a string")
        return
    try:
        result = opf.redact(text)
    except Exception as e:
        _fail(req_id, f"scan failed: {e}\n{traceback.format_exc()}")
        return

    spans = [
        {
            "label": span.label,
            "start": int(span.start),
            "end": int(span.end),
            "text": span.text,
        }
        for span in result.detected_spans
    ]
    _ok(req_id, {"spans": spans, "redacted_text": result.redacted_text})


def main() -> None:
    opf = _build_opf()

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue

        try:
            req = json.loads(line)
        except Exception as e:  # malformed JSON
            _fail(None, f"bad JSON: {e}")
            continue

        if not isinstance(req, dict):
            _fail(None, "request must be a JSON object")
            continue

        req_id = req.get("id")
        op = req.get("op")

        if op == "ping":
            _ok(req_id, {})
            continue

        if op == "shutdown":
            _ok(req_id, {})
            return

        if op == "scan":
            _handle_scan(opf, req_id, req.get("text"))
            continue

        _fail(req_id, f"unknown op: {op!r}")


if __name__ == "__main__":
    main()
