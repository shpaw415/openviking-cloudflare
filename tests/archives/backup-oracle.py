# SPDX-License-Identifier: AGPL-3.0-only
"""Independent OVPack v3 verifier. No imports from the candidate or pinned checkout."""
import hashlib
import io
import json
import sys
import zipfile

PREFIX = 'openviking-backup/'
META = PREFIX + '_ovpack/'
RECORDS = '_ovpack/index_records.jsonl'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def verify(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert archive.testzip() is None
        names = archive.namelist()
        assert len(names) == len(set(names))
        manifest = json.loads(archive.read(META + 'manifest.json'))
        assert manifest['kind'] == 'openviking.ovpack' and manifest['format_version'] == 3
        assert manifest['root'] == dict(name='openviking-backup', uri='viking://', scope='root', package_type='backup')
        assert manifest['scopes'] == ['resources', 'user']
        entries = {row['path']: row for row in manifest['entries']}
        assert len(entries) == len(manifest['entries'])
        assert all(entries[root]['kind'] == 'directory' for root in ('', 'resources', 'user'))
        expected = {PREFIX, META, META + 'manifest.json', PREFIX + RECORDS}
        by_uri, dirs, checks = {}, [], []
        for path, entry in sorted(entries.items()):
            parts = path.split('/') if path else []
            assert all(part not in ('', '.', '..') for part in parts)
            owner = parts[1] if len(parts) >= 2 and parts[0] == 'user' else None
            assert entry.get('user_id') == owner
            if path:
                assert entries[path.rpartition('/')[0]]['kind'] == 'directory'
            uri = 'viking://' + path
            directory = entry['kind'] == 'directory'
            name = PREFIX + 'files/' + path + ('/' if path and directory else '')
            expected.add(name)
            body = archive.read(name)
            if directory:
                assert not body and entry.get('size', 0) == 0
                dirs.append(uri)
            else:
                check = dict(path=path, size=len(body), sha256=sha(body))
                assert all(entry[key] == value for key, value in check.items())
                assert entry['kind'] == 'file'
                by_uri[uri] = sha(body)
                checks.append(check)
        assert expected == set(names)
        assert manifest['content_sha256'] == sha(json.dumps(checks, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
        index = archive.read(PREFIX + RECORDS)
        records = [json.loads(line) for line in index.splitlines()]
        assert manifest['index'] == dict(records=dict(path=RECORDS, count=len(records), sha256=sha(index)))
        for record in records:
            entry = entries[record['path']]
            assert entry.get('user_id') == record.get('user_id')
            assert entry['kind'] == record['kind']
        return dict(sha256=sha(raw), files=by_uri, directories=dirs, records=records)


def rewrite(raw, variant):
    """A DEFLATE repack or a bounded negative, from the synthetic package only."""
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        items = {name: archive.read(name) for name in archive.namelist()}
    name = META + 'manifest.json'
    manifest = json.loads(items[name])
    if variant == 'field':
        manifest['root']['account_id'] = 'not-a-format-field'
    elif variant == 'mount':
        manifest['scopes'] = ['resources']
    elif variant == 'owner':
        next(row for row in manifest['entries'] if row.get('user_id') == 'ada')['user_id'] = 'ben'
    elif variant == 'checksum':
        leaf = PREFIX + 'files/' + next(row['path'] for row in manifest['entries'] if row['kind'] == 'file')
        items[leaf] = b'x' * len(items[leaf])
    elif variant == 'sessions':
        path = 'user/ada/sessions'
        manifest['entries'].append(dict(path=path, kind='directory', size=0, user_id='ada'))
        items[PREFIX + 'files/' + path + '/'] = b''
    elif variant not in ('deflate', 'duplicate'):
        raise ValueError('unexpected fixture variant')
    items[name] = json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2).encode()
    if variant == 'duplicate':
        items[name] = b'{"format_version": 3,' + items[name][1:]
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for path, data in items.items():
            archive.writestr(path, data)
    return out.getvalue()


def verify_edge(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert archive.testzip() is None
        names = {'manifest.json', 'content.ovpack', 'domains.json'}
        assert len(archive.infolist()) == len(names) and set(archive.namelist()) == names
        manifests = json.loads(archive.read('manifest.json'))
        entries = [dict(path=path, size=len(archive.read(path)), sha256=sha(archive.read(path)))
                   for path in ('content.ovpack', 'domains.json')]
        assert manifests == dict(kind='openviking.edge-backup', format_version=1, entries=entries)
        ovpack = verify(archive.read('content.ovpack'))
        domains = json.loads(archive.read('domains.json'))
        assert set(domains) == {'sessions', 'skills', 'settings'}
        for skill in domains['skills']:
            assert set(skill) == {'uri', 'content', 'files'}
        for setting in domains['settings']:
            assert set(setting) == {'uri', 'resource_uri', 'skill_uri'}
        for session in domains['sessions']:
            assert set(session) == {'uri', 'created_at', 'updated_at', 'last_message_at', 'last_commit_at', 'keep_recent_count',
                                    'memory_policy', 'tags', 'messages', 'archives'}
            for messages in [session['messages']] + [item['messages'] for item in session['archives']]:
                assert all(set(message) == {'id', 'role', 'parts', 'created_at'} for message in messages)
        return dict(sha256=sha(raw), files=ovpack['files'], **{k: [item['uri'] for item in v] for k, v in domains.items()})


data = sys.stdin.buffer.read(1_500_001)
assert 0 < len(data) <= 1_500_000
if sys.argv[1] == 'verify':
    json.dump(verify(data), sys.stdout)
elif sys.argv[1] == 'verify-edge':
    json.dump(verify_edge(data), sys.stdout)
else:
    sys.stdout.buffer.write(rewrite(data, sys.argv[1]))
