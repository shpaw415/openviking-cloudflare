# SPDX-License-Identifier: AGPL-3.0-only
"""Read pinned upstream commit assertions as data; no upstream imports or exec.

Only this allowlisted AST subset can emit a request on stdout. Node owns HTTP
and supplies the unmodified JSON/status from an isolated Workerd instance.
"""
import ast
import hashlib
import json
from pathlib import Path
import re
import sys

ROOT = Path(__file__).resolve().parents[2] / "upstream/tests/api_test"
NAME = "sessions/test_session_commit_context.py"
CASES = {"test_session_commit_flow", "test_session_commit_returns_task_id", "test_session_commit_empty_session"}


def pinned(path, expected):
    data = (ROOT / path).read_bytes()
    if hashlib.sha256(data).hexdigest() != expected:
        raise ValueError("Upstream contract bytes changed")
    return data.decode("utf-8")


def client(name, values):
    base = "/api/v1/sessions"
    if name == "create_session" and not values:
        method, path, body = "POST", base, {}
    else:
        if not values or not isinstance(values[0], str) or not re.fullmatch(r"[a-zA-Z0-9_.@-]{1,255}", values[0]):
            raise ValueError("Invalid fixture session id")
        base += "/" + values[0]
        if name == "add_message" and len(values) == 3:
            method, path, body = "POST", base + "/messages", {"role": values[1], "content": values[2]}
        elif name == "session_commit" and len(values) == 1:
            method, path, body = "POST", base + "/commit", {}
        elif name == "delete_session" and len(values) == 1:
            method, path, body = "DELETE", base, None
        else:
            raise ValueError("Unrecognized fixture operation")
    print(json.dumps({"op": name, "method": method, "path": path, "body": body}), flush=True)
    return json.loads(sys.stdin.readline(128 * 1024))


def interpret(source, body):
    env = {"api_client": object(), "str": str}
    fuel = 512

    def ev(node):
        nonlocal fuel
        fuel -= 1
        if fuel < 0:
            raise ValueError("AST budget exceeded")
        if isinstance(node, ast.Name):
            return env[node.id]
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Dict) and not node.keys:
            return {}
        if isinstance(node, ast.Subscript):
            return ev(node.value)[ev(node.slice)]
        if isinstance(node, ast.Attribute) and node.attr == "status_code":
            return ev(node.value)["status_code"]
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = ev(node.left), ev(node.comparators[0])
            op = node.ops[0]
            if isinstance(op, ast.Eq):
                return left == right
            if isinstance(op, ast.In):
                return left in right
            if isinstance(op, ast.Gt):
                return left > right
        if isinstance(node, ast.Call) and not node.keywords:
            args = [ev(arg) for arg in node.args]
            if isinstance(node.func, ast.Attribute):
                target = ev(node.func.value)
                if target is env["api_client"]:
                    return client(node.func.attr, args)
                if node.func.attr == "json" and not args:
                    return target["json"]
                if node.func.attr == "get" and isinstance(target, dict):
                    return target.get(*args)
            if isinstance(node.func, ast.Name) and node.func.id in {"isinstance", "len"}:
                return {"isinstance": isinstance, "len": len}[node.func.id](*args)
        raise ValueError(f"Refused upstream expression {type(node).__name__}:{node.lineno}")

    def interpret_body(nodes):
        for node in nodes:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                env[node.targets[0].id] = ev(node.value)
            elif isinstance(node, ast.Expr):
                ev(node.value)
            elif isinstance(node, ast.Assert) and node.msg is None:
                if not ev(node.test):
                    raise AssertionError(f"{NAME}:{node.lineno}: {ast.get_source_segment(source, node.test)}")
            elif isinstance(node, ast.If):
                interpret_body(node.body if ev(node.test) else node.orelse)
            elif isinstance(node, ast.Try) and not node.handlers and not node.orelse:
                try:
                    interpret_body(node.body)
                finally:
                    interpret_body(node.finalbody)
            else:
                raise ValueError(f"Refused upstream statement {type(node).__name__}:{node.lineno}")

    interpret_body(body)


if __name__ == "__main__":
    case, = sys.argv[1:]
    if case not in CASES:
        raise ValueError("Case is not admitted")
    source = pinned(NAME, "17ade65856720407626df79f3c33ea1839ed65a1bafed97fbc4439d7619aa3f9")
    pinned("api/client.py", "e27efa85aebdc2d92bddfda0fe27973981d7f262b82a929f7772818c2a1e4826")
    suite, = (n for n in ast.parse(source).body if isinstance(n, ast.ClassDef) and n.name == "TestSessionCommitContext")
    test, = (n for n in suite.body if isinstance(n, ast.FunctionDef) and n.name == case and not n.decorator_list)
    interpret(source, test.body)
