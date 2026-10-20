"""Safely expand downloaded Linux wheels into a new isolated build directory."""
import argparse
import hashlib
import json
import stat
import zipfile
from email.parser import Parser
from pathlib import Path,PurePosixPath

TARGET='CPython3.10 Linux glibc x86_64 manylinux_2_17'

def stage(wheel_dir,destination):
    wheel_dir=Path(wheel_dir).resolve();destination=Path(destination).resolve()
    if destination.exists():raise ValueError('Use a new staging directory; no overwrite')
    wheels=sorted(wheel_dir.glob('*.whl'))
    if not wheels:raise ValueError('No wheels downloaded')
    packages=[];entries=[];names=set()
    for wheel in wheels:
        if wheel.is_symlink():raise ValueError('Wheel symlink forbidden')
        with zipfile.ZipFile(wheel) as archive:
            metadata=[name for name in archive.namelist() if name.endswith('.dist-info/METADATA')]
            if len(metadata)!=1:raise ValueError('One wheel metadata record required')
            meta=Parser().parsestr(archive.read(metadata[0]).decode('utf-8'))
            packages.append({'name':meta['Name'],'version':meta['Version'],'wheel':wheel.name,'sha256':hashlib.sha256(wheel.read_bytes()).hexdigest()})
            for entry in archive.infolist():
                relative=PurePosixPath(entry.filename)
                if relative.is_absolute() or '..' in relative.parts or '\\' in entry.filename or ':' in entry.filename or stat.S_ISLNK(entry.external_attr>>16):raise ValueError('Unsafe wheel archive path')
                if entry.is_dir():continue
                if any(part.endswith('.data') for part in relative.parts):raise ValueError('Wheel data relocation needs explicit review')
                if entry.filename in names:raise ValueError('Wheel file collision')
                names.add(entry.filename);entries.append((wheel,entry.filename))
    destination.mkdir(parents=True)
    for wheel,name in entries:
        target=(destination/name).resolve()
        if not target.is_relative_to(destination):raise ValueError('Extraction escaped staging directory')
        target.parent.mkdir(parents=True,exist_ok=True)
        with zipfile.ZipFile(wheel) as archive:target.write_bytes(archive.read(name))
    lock={'target':TARGET,'source':'https://pypi.org/simple','cloud_runtime_verified':False,'packages':packages}
    (destination/'DEPENDENCY-LOCK.json').write_text(json.dumps(lock,indent=2)+'\n',encoding='utf-8')
    return lock

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--wheels',required=True);parser.add_argument('--destination',required=True);args=parser.parse_args()
    lock=stage(args.wheels,args.destination)
    destination=Path(args.destination).resolve()
    (destination.parent/'requirements-linux-cp310.lock.txt').write_text(''.join(p['name']+'=='+p['version']+' --hash=sha256:'+p['sha256']+'\n' for p in lock['packages']),encoding='utf-8')
    print('Staged',len(lock['packages']),'hashed Linux-target wheels; no system Python installation performed.')
