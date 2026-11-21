# SPDX-License-Identifier: AGPL-3.0-only
"""Declarative replay of a bounded subset of pinned upstream test statements.

This does not import, compile/execute, or start upstream Python. The AST admits
only literals, calls to the transport fixture, data access, and assertions.
Only the Node driver can issue HTTP; it dispatches to its isolated workerd.
"""
import ast
import hashlib
import json
from pathlib import Path
import sys

UPSTREAM = Path(__file__).resolve().parents[2] / "upstream"
FILES = {
    "skills": ("tests/server/test_api_skills.py", "3e278dd2cf15de928d6a1c06d9120ff69ef87f622d2f71552b813514758634bd"),
    "batch": ("tests/server/test_content_batch_write.py", "0a02ca0af4e248bdc462d55c4fe5a1d9f84ae2f59c2299a2f31a5f07b4194d88"),
    "filter": ("tests/api_test/retrieval/slow/test_search_advanced.py", "1e9add215a350776252d6f98d9bc7050bf12a28cd820cb253cfb25252c8f745b"),
}
CASES = {
    "skills": ("test_skills_api_list_empty_collection", "test_skills_api_list_honors_node_limit", "test_skills_api_validate_inline_skill"),
    "batch": ("test_batch_write_api_create_overwrites_and_batch_continues", "test_batch_write_api_missing_append_creates_file", "test_batch_write_api_upserts_files"),
    "filter": ("test_find_with_filter_parameter",),
}


def fixture(method, args, keywords):
    if method == "find":
        path, kind, params, data = "/api/v1/search/find", "POST", {}, keywords
    elif method in {"get", "post", "put"} and len(args) == 1 and set(keywords) <= {"json", "params"}:
        path, kind, params, data = args[0], method.upper(), keywords.get("params", {}), keywords.get("json")
    else:
        raise ValueError("Unsupported client call")
    print(json.dumps(dict(path=path, method=kind, query=params, body=data)), flush=True)
    reply = sys.stdin.readline(192 * 1024)
    return json.loads(reply)


def interpret(path, original, name, initial):
    tree = ast.parse(original)
    allowed = {"_skill_md", "_add_skill", name}
    # Only known classes or top-level test helpers are recognized.
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))]
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "TestSearchAdvanced":
            nodes.extend(node.body)
    funcs = {node.name: node for node in nodes if getattr(node, "name", None) in allowed}
    fuel = 1500

    def expression(node, env):
        nonlocal fuel
        fuel -= 1
        if fuel < 0:
            raise ValueError("Too many operations in source contract")
        ev = lambda value: expression(value, env)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Name):
            return env[node.id]
        if isinstance(node, ast.Await):
            return ev(node.value)
        if isinstance(node, (ast.List, ast.Tuple)):
            return [ev(value) for value in node.elts]
        if isinstance(node, ast.Dict):
            return {ev(key): ev(value) for key, value in zip(node.keys, node.values)}
        if isinstance(node, ast.Subscript):
            return ev(node.value)[ev(node.slice)]
        if isinstance(node, ast.JoinedStr):
            return "".join(ev(value) for value in node.values)
        if isinstance(node, ast.FormattedValue) and node.format_spec is None:
            return str(ev(node.value))
        if isinstance(node, ast.Attribute) and node.attr in {"status_code", "text"}:
            return ev(node.value)[node.attr]
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            a, b = ev(node.left), ev(node.comparators[0])
            op = type(node.ops[0])
            if op is ast.Eq:
                return a == b
            if op is ast.Is:
                return a is b
            if op is ast.In:
                return a in b
        if isinstance(node, ast.GeneratorExp) and len(node.generators) == 1:
            gen = node.generators[0]
            if isinstance(gen.target, ast.Name) and not gen.ifs and not gen.is_async:
                return [expression(node.elt, {**env, gen.target.id: value}) for value in ev(gen.iter)]
        if isinstance(node, ast.Call):
            args = [ev(value) for value in node.args]
            kw = {item.arg: ev(item.value) for item in node.keywords}
            if isinstance(node.func, ast.Attribute):
                target = ev(node.func.value)
                if target == "fixture":
                    return fixture(node.func.attr, args, kw)
                if node.func.attr == "json" and not args and not kw:
                    return target["json"]
                if node.func.attr == "get" and isinstance(target, dict) and 1 <= len(args) <= 2 and not kw:
                    return target.get(*args)
            if isinstance(node.func, ast.Name):
                if node.func.id in {"any", "sorted"} and len(args) == 1 and not kw:
                    return {"any": any, "sorted": sorted}[node.func.id](args[0])
                if node.func.id in funcs and node.func.id != name and not kw:
                    return function(node.func.id, args)
        raise ValueError(f"Unsupported expression: {type(node).__name__} at line {node.lineno}")

    def statements(nodes, env):
        for node in nodes:
            ev = lambda value: expression(value, env)
            if isinstance(node, ast.Assert):
                if not ev(node.test):
                    raise AssertionError(f"{path}:{node.lineno}: {ast.get_source_segment(original, node.test)}")
            elif isinstance(node, ast.Assign) and len(node.targets) == 1:
                target, result = node.targets[0], ev(node.value)
                if isinstance(target, ast.Name):
                    env[target.id] = result
                elif isinstance(target, ast.Tuple) and all(isinstance(item, ast.Name) for item in target.elts):
                    env.update({key.id: value for key, value in zip(target.elts, result, strict=True)})
                else:
                    raise ValueError("Unsupported assignment")
            elif isinstance(node, ast.Expr):
                ev(node.value)
            elif isinstance(node, ast.If):
                done, value = statements(node.body if ev(node.test) else node.orelse, env)
                if done:
                    return done, value
            elif isinstance(node, ast.Return):
                return True, ev(node.value)
            else:
                raise ValueError(f"Unsupported statement: {type(node).__name__}")
        return False, None

    def function(name, params):
        fn = funcs[name]
        args = [arg.arg for arg in fn.args.args]
        defaults = {arg: expression(value, {}) for arg, value in zip(args[len(args)-len(fn.args.defaults):], fn.args.defaults)}
        values = {**defaults, **dict(zip(args, params))}
        if len(values) != len(args):
            raise ValueError("Incorrect replay arguments")
        return statements(fn.body, values)[1]

    function(name, initial)


if __name__ == "__main__":
    family, name, root = sys.argv[1:]
    if name not in CASES[family]:
        raise ValueError("Case not admitted")
    path, digest = FILES[family]
    data = (UPSTREAM / path).read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError("Pinned upstream file changed")
    initial = [["fixture", root]] if family == "batch" else [None, "fixture"] if family == "filter" else ["fixture"]
    interpret(path, data.decode("utf-8"), name, initial)
