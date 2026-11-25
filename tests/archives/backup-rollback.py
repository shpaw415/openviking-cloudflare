# SPDX-License-Identifier: AGPL-3.0-only
"""Inject or remove a synthetic last-domain SQLite failure while Workerd is stopped."""
from pathlib import Path
import sqlite3
import sys

HOME = Path(__file__).resolve().parents[2] / '.work'
path = Path(sys.argv[1]).resolve(strict=True)
assert path.parent == HOME and path.name.startswith('b-')
files = []
for db in (path / 'state').rglob('*.sqlite'):
    assert db.resolve() == db and db.stat().st_nlink == 1
    with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True) as conn:
        if not conn.execute("SELECT 1 FROM sqlite_schema WHERE name='ov_edge_fs_entry'").fetchone():
            continue
        if conn.execute("SELECT 1 FROM ov_edge_fs_entry WHERE account_id='edge-domains-fixture' AND uri='viking://resources/rollback-sentinel.txt'").fetchone():
            files.append(db)
assert len(files) == 1
with sqlite3.connect(files[0].as_uri() + '?mode=rw', uri=True) as conn:
    if sys.argv[2] == 'add':
        conn.execute("""CREATE TRIGGER synthetic_abort BEFORE INSERT ON ov_edge_user_add_settings
            WHEN new.account_id='edge-domains-fixture' AND new.user_id='ada'
            AND EXISTS (SELECT 1 FROM ov_sessions WHERE account_id=new.account_id AND session_id='round-trip')
            AND EXISTS (SELECT 1 FROM ov_edge_fs_skill WHERE account_id=new.account_id AND uri='viking://user/ada/skills/field-notes')
            AND EXISTS (SELECT 1 FROM ov_edge_fs_entry WHERE account_id=new.account_id AND uri='viking://user/ada/resources/imports/fixture.md')
            BEGIN SELECT RAISE(ABORT, 'synthetic last-domain failure'); END""")
    else:
        assert sys.argv[2] == 'remove'
        conn.execute('DROP TRIGGER synthetic_abort')
