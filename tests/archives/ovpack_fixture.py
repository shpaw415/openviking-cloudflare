"""Independent small v3 package generator/verifier. Standard library only."""
import hashlib
import io
import json
import sys
import zipfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def listing_digest(files):
    data = sorted(files, key=lambda file: file['path'])
    return digest(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())


def create(corrupt=False):
    text = 'texte marin\n'.encode()
    data = {'path': 'chapitre/café.md', 'size': len(text), 'sha256': digest(text)}
    manifest = {
        'kind': 'openviking.ovpack', 'format_version': 3,
        'root': {'name': 'notes', 'uri': 'viking://resources/notes', 'scope': 'resources'},
        'entries': [{'path': '', 'kind': 'directory'}, {'path': 'chapitre', 'kind': 'directory'},
                    {'kind': 'file', **data}],
        'content_sha256': listing_digest([data]),
        'index': {'records': {'path': '_ovpack/index_records.jsonl', 'count': 0, 'sha256': digest(b'')}},
    }
    if corrupt:
        # Valid ZIP transport but a manifest that is not the digest of those bytes.
        manifest['content_sha256'] = '0' * 64
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        for name in ('notes/', 'notes/files/', 'notes/files/chapitre/', 'notes/_ovpack/'):
            archive.writestr(name, b'')
        archive.writestr('notes/files/' + data['path'], text)
        archive.writestr('notes/_ovpack/index_records.jsonl', b'')
        archive.writestr('notes/_ovpack/manifest.json', json.dumps(manifest, ensure_ascii=False))
    sys.stdout.buffer.write(buffer.getvalue())


def inspect(raw):
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        assert archive.testzip() is None
        manifest = json.loads(archive.read('notes/_ovpack/manifest.json'))
        assert manifest['format_version'] == 3 and manifest['kind'] == 'openviking.ovpack'
        assert manifest['root'] == {'name': 'notes', 'scope': 'resources', 'uri': 'viking://resources/notes'}
        files, entries, directories = {}, [], []
        for entry in manifest['entries']:
            rel = entry['path']
            if entry['kind'] == 'directory':
                assert archive.getinfo('notes/files/' + (rel + '/' if rel else '')).is_dir()
                directories.append(rel)
                continue
            contents = archive.read('notes/files/' + rel)
            assert len(contents) == entry['size'] and digest(contents) == entry['sha256']
            entries.append({key: entry[key] for key in ('path', 'size', 'sha256')})
            files[rel] = contents.decode('utf-8')
        assert manifest['content_sha256'] == listing_digest(entries)
        meta = manifest['index']['records']
        assert meta['sha256'] == digest(archive.read('notes/' + meta['path']))
        print(json.dumps({'files': files, 'directories': sorted(directories)}))


if __name__ == '__main__':
    if sys.argv[1] in ('create', 'corrupt'):
        create(sys.argv[1] == 'corrupt')
    elif sys.argv[1] == 'inspect':
        inspect(sys.stdin.buffer.read())
    else:
        raise SystemExit(2)
