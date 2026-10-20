"""Explicit allowlist SCF archive. Source-only by default; never vendors host Python."""
import argparse
import json
import re
import zipfile
import hashlib
import stat
from pathlib import Path, PurePosixPath
from email.parser import Parser

ROOT=Path(__file__).resolve().parent
SOURCES=('scf_handler.py','requirements.txt','member_service/__init__.py','member_service/http.py','member_service/service.py','member_service/storage.py','member_service/cloudbase_auth.py','member_service/runtime.py','member_service/cloudbase_pg.py','member_service/cloud_member_service.py','member_service/cloudbase_shared_auth.py','member_service/cloud_assets.py','member_service/literature.py','member_service/article_export.py')
DISTRIBUTIONS={'cryptography','cffi','pycparser','psycopg','psycopg-binary','typing-extensions','tzdata','tencentcloud-sdk-python-tcb','tencentcloud-sdk-python-common','requests','certifi','charset-normalizer','idna','urllib3'}
FORBIDDEN={'.private','runtime','tests','__pycache__','.git','.env'}

def dependency_files(folder):
    folder=folder.resolve()
    metadata=list(folder.glob('*.dist-info/METADATA'))
    if not metadata:raise ValueError('Dependency directory lacks wheel metadata; build Linux wheels explicitly.')
    found=set()
    for item in metadata:
        name=Parser().parsestr(item.read_text(encoding='utf-8')).get('Name','').lower().replace('_','-')
        if name not in DISTRIBUTIONS:raise ValueError('Unexpected dependency distribution')
        found.add(name)
        tags=[line[5:] for line in item.with_name('WHEEL').read_text().splitlines() if line.startswith('Tag: ')]
        compatible=False
        for tag in tags:
            parts=tag.split('-')
            if len(parts)!=3:continue
            interpreter,abi,platform=parts
            generic=platform=='any' and abi=='none' and ('py3' in interpreter.split('.') or interpreter=='cp310')
            minimum=int(interpreter[2:]) if interpreter.startswith('cp') and interpreter[2:].isdigit() else None
            interpreter_ok=(interpreter=='cp310' and abi=='cp310') or (abi=='abi3' and minimum is not None and 32<=minimum<=310)
            linux='manylinux' in platform and platform.endswith('_x86_64') and interpreter_ok
            if generic or linux:compatible=True
        if not compatible:raise ValueError('Wheel is not compatible with CPython3.10 Linux glibc x86_64')
    if not {'cryptography','psycopg','psycopg-binary','tencentcloud-sdk-python-tcb','tencentcloud-sdk-python-common','requests','certifi','charset-normalizer','idna','urllib3'}.issubset(found):raise ValueError('Required production dependencies are incomplete')
    files=[]
    for item in folder.rglob('*'):
        if item.is_symlink():raise ValueError('Symlink is forbidden in dependency bundle')
        if not item.is_file():continue
        relative=item.relative_to(folder)
        if any(part in {'.private','runtime','.git','.env'} for part in relative.parts):raise ValueError('Private dependency path forbidden')
        if any(part in {'tests','__pycache__'} for part in relative.parts):continue
        if item.suffix.lower() in ('.pyd','.dll','.exe','.dylib','.pdf','.key','.sqlite','.db') or (item.suffix.lower()=='.pem' and relative.as_posix()!='certifi/cacert.pem'):raise ValueError('Forbidden platform or private dependency file')
        if item.name.startswith('.env'):raise ValueError('Secret configuration must never be bundled')
        if '.so' in item.name:
            header=item.read_bytes()[:20]
            if header[:5]!=b'\x7fELF\x02' or header[5]!=1 or int.from_bytes(header[18:20],'little')!=62:raise ValueError('Native binary must be Linux ELF64 x86_64')
            match=re.search(r'cpython-(\d+)',item.name)
            if match and match[1]!='310':raise ValueError('Wrong native CPython ABI')
        files.append((item,relative.as_posix()))
    return files

def extract_locked_wheels(wheelhouse, destination, lock_file):
    """Extract only named, SHA256-pinned wheels into a new dependency directory."""
    wheelhouse=Path(wheelhouse).resolve();destination=Path(destination).resolve()
    if destination.exists():raise ValueError('Dependency destination must be new')
    locks=json.loads(Path(lock_file).read_text(encoding='utf-8'))
    if not isinstance(locks,dict) or not locks:raise ValueError('Empty wheel lock')
    actual={p.name for p in wheelhouse.glob('*.whl')}
    if actual!=set(locks):raise ValueError('Wheelhouse does not match lock')
    destination.mkdir(parents=True)
    seen={}
    try:
        for filename,digest in sorted(locks.items()):
            if not re.fullmatch(r'[A-Za-z0-9_.-]+\.whl',filename) or not re.fullmatch(r'[0-9a-f]{64}',digest):raise ValueError('Invalid wheel lock')
            wheel=wheelhouse/filename
            if wheel.is_symlink() or hashlib.sha256(wheel.read_bytes()).hexdigest()!=digest:raise ValueError('Wheel hash mismatch')
            with zipfile.ZipFile(wheel) as archive:
                for entry in archive.infolist():
                    name=entry.filename
                    parts=PurePosixPath(name).parts
                    if name.startswith('/') or '\\' in name or ':' in name or not parts or any(x in ('','.','..') for x in name.split('/')):raise ValueError('Unsafe wheel path')
                    if stat.S_IFMT(entry.external_attr >> 16)==stat.S_IFLNK:raise ValueError('Wheel symlink forbidden')
                    if entry.is_dir():continue
                    if name in seen:
                        if seen[name]!=hashlib.sha256(archive.read(entry)).hexdigest() and name!='tencentcloud/__init__.py':raise ValueError('Wheel path collision')
                        continue
                    target=destination/name;target.parent.mkdir(parents=True,exist_ok=True)
                    data=archive.read(entry);target.write_bytes(data);seen[name]=hashlib.sha256(data).hexdigest()
        dependency_files(destination)
    except BaseException:
        import shutil
        shutil.rmtree(destination)
        raise

def build(destination,dependencies=None):
    destination=Path(destination).resolve()
    if destination.exists():raise ValueError('Archive already exists; no overwrite')
    if destination.is_relative_to(ROOT/'.private') or destination.is_relative_to(ROOT/'runtime'):raise ValueError('Choose a separate build output directory')
    files=[]
    for name in SOURCES:
        path=ROOT/name
        if path.is_symlink() or not path.resolve().is_relative_to(ROOT):raise ValueError('Source allowlist escaped project')
        files.append((path,name))
    if dependencies:files.extend(dependency_files(Path(dependencies)))
    names=[name for _,name in files]
    if len(names)!=len(set(names)):raise ValueError('Archive path collision')
    destination.parent.mkdir(parents=True,exist_ok=True)
    manifest={'target':'CPython3.10 Linux glibc x86_64','source_only':not bool(dependencies),'cloud_runtime_verified':False,'glibc_compatibility_verified':False,'files':sorted(names)}
    try:
        with zipfile.ZipFile(destination,'x',compression=zipfile.ZIP_DEFLATED) as archive:
            for path,name in files:archive.write(path,name)
            archive.writestr('BUILD-MANIFEST.json',json.dumps(manifest,indent=2))
    except BaseException:
        if destination.exists():destination.unlink()
        raise
    return manifest

def prepare_linux_stage(destination):
    import shutil
    destination=Path(destination).resolve()
    if destination.exists():raise ValueError('Build staging directory must be new')
    destination.mkdir(parents=True)
    for name in (*SOURCES,'build_scf_bundle.py'):
        source=ROOT/name
        if source.is_symlink() or not source.resolve().is_relative_to(ROOT):raise ValueError('Source escaped project')
        target=destination/name;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(source,target)

if __name__=='__main__':
    parser=argparse.ArgumentParser();group=parser.add_mutually_exclusive_group(required=True);group.add_argument('--output');group.add_argument('--prepare-linux-stage');group.add_argument('--extract-locked-wheels');parser.add_argument('--linux-dependencies');parser.add_argument('--wheelhouse');parser.add_argument('--wheel-lock');args=parser.parse_args()
    if args.prepare_linux_stage:
        prepare_linux_stage(args.prepare_linux_stage);print('Prepared clean allowlist-only Linux build staging; no private configuration mounted.')
    elif args.extract_locked_wheels:
        if not args.wheelhouse or not args.wheel_lock:parser.error('Wheelhouse and wheel lock required')
        extract_locked_wheels(args.wheelhouse,args.extract_locked_wheels,args.wheel_lock)
        print('Extracted verified Linux dependencies.')
    else:
        result=build(args.output,args.linux_dependencies)
        print('Created source-only archive; not runnable until Linux dependencies are built.' if result['source_only'] else 'Created Linux-target dependency archive; cloud-runtime import smoke test remains required.')
