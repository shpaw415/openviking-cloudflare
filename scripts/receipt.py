#!/usr/bin/env python3
"""Print the content identity of the native candidate, without opening any secret/config file."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parent.parent
ROOT_FILES=('package.json','package-lock.json','wrangler.jsonc','tsconfig.json')
DIRS={'src':{'.ts'},'tests':{'.mjs','.ts','.py','.md','.json','.txt','.c','.xml','.csv','.toml','.ovpack'},
      'studio-patches':{'.patch','.ts','.py','.c'},'scripts':{'.mjs','.sh','.py'}}


def sign(files):
    result={}
    for path in sorted(files):
        if path.is_symlink() or not path.is_file():
            raise ValueError(f'Candidate input is missing or not a regular file: {path.relative_to(ROOT)}')
        with path.open('rb') as file:
            result[path.relative_to(ROOT).as_posix()]=hashlib.file_digest(file,'sha256').hexdigest()
    return result


def main():
    files={ROOT/name for name in ROOT_FILES}
    for folder,suffixes in DIRS.items():
        files.update(p for p in (ROOT/folder).rglob('*') if p.suffix in suffixes and not any(part.startswith('.') for part in p.relative_to(ROOT).parts))
    hashes=sign(files)
    studio=sign({ROOT/'dist/studio/index.html'})
    raw=subprocess.run(['/usr/bin/git','-C',str(ROOT/'upstream'),'rev-parse','HEAD'],check=True,capture_output=True,text=True)
    print(json.dumps({'upstream_commit':raw.stdout.strip(),'source_set_sha256':hashlib.sha256(json.dumps(hashes,sort_keys=True,separators=(',',':')).encode()).hexdigest(),
                      'studio_entry_sha256':next(iter(studio.values())), 'file_count':len(hashes),'source_and_test_hashes':hashes},indent=2,sort_keys=True))


if __name__=='__main__':
    main()
