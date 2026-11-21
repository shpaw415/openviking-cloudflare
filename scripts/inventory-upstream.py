#!/usr/bin/env python3
"""Enumerate statically declared upstream FastAPI methods; never import upstream."""
import ast
import subprocess
from collections import Counter
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parent.parent / 'upstream'
PIN = '000f0765d7ec183886fbabbc22e69bc289cc429d'
METHODS = {'get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'websocket', 'api_route'}


def git(*args):
    return subprocess.run(['/usr/bin/git', '-C', str(ROOT), *args], check=True, capture_output=True).stdout.decode()


def literal(node, names):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return names.get(node.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = literal(node.left, names), literal(node.right, names)
        if left is not None and right is not None:
            return left + right
    return None


def routes(source):
    names, prefixes = {}, {'app': ''}
    for statement in source.body:
        if not isinstance(statement, ast.Assign) or len(statement.targets) != 1 or not isinstance(statement.targets[0], ast.Name):
            continue
        name = statement.targets[0].id
        value = statement.value
        string = literal(value, names)
        if string is not None:
            names[name] = string
        if isinstance(value, ast.Call) and isinstance(value.func, ast.Name) and value.func.id == 'APIRouter':
            prefix = next((literal(kw.value, names) for kw in value.keywords if kw.arg == 'prefix'), '')
            prefixes[name] = prefix
    for handler in ast.walk(source):
        if not isinstance(handler, (ast.AsyncFunctionDef, ast.FunctionDef)):
            continue
        for call in handler.decorator_list:
            if not isinstance(call, ast.Call) or not isinstance(call.func, ast.Attribute) or not isinstance(call.func.value, ast.Name):
                continue
            receiver, method = call.func.value.id, call.func.attr
            if receiver not in prefixes or method not in METHODS or not call.args:
                continue
            suffix = literal(call.args[0], names)
            prefix = prefixes[receiver]
            path = prefix + suffix if prefix is not None and suffix is not None else '<computed>'
            yield (method.upper(), path, call.lineno)


def main():
    if git('rev-parse', 'HEAD').strip() != PIN:
        raise SystemExit('Upstream checkout is not at the expected pin.')
    files = git('ls-tree', '-r', '--name-only', 'HEAD', 'openviking/server', 'openviking_gateway').splitlines()
    totals = Counter()
    print('module\tmethod\tpath (declared)\tline')
    for path in files:
        if not path.endswith('.py'):
            continue
        source = ast.parse(git('show', f'HEAD:{path}'))
        for method, url, line in sorted(routes(source), key=lambda row: row[2]):
            totals['computed' if url == '<computed>' else 'literal'] += 1
            print(f'{path}\t{method}\t{url}\t{line}')
    print(f'Declared decorators: {totals.total()} ({totals["literal"]} literal, {totals["computed"]} unresolved). '
          'Mount prefixes, dynamic registrations and active profiles are not inferred.', file=sys.stderr)


if __name__ == '__main__':
    main()
