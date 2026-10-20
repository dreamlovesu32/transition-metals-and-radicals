"""Loopback-only development composition; pending content never served statically."""
import json
import mimetypes
import re
from pathlib import Path
from urllib.parse import unquote

class LocalSite:
    def __init__(self,api,root,public_ids=('paper01','r20261017-01','r20261017-02','r20261017-04','r20261017-05')):
        self.api,self.root,self.public_ids=api,Path(root).resolve(),set(public_ids)
    def __call__(self,e,start):
        path=e.get('PATH_INFO','/')
        if path.startswith('/api/member/'):
            return self.api(e,start)
        def fail():
            start('404 Not Found',[('Content-Type','text/plain'),('Cache-Control','no-store')]);return [b'Not found']
        if e.get('REQUEST_METHOD')!='GET':return fail()
        path=unquote(path)
        if path in ('/','/index.html'):relative='index.html'
        elif path in ('/read','/read.html'):relative='read.html'
        else:relative=path.lstrip('/')
        catalog=json.loads((self.root/'catalog.json').read_text(encoding='utf-8'))
        public=[item for item in catalog['articles'] if item['id'] in self.public_ids and item.get('reviewStatus') in ('existing-public-baseline','approved','proofreading')]
        allowed={item['id'] for item in public}
        if relative=='catalog.json':
            body=json.dumps({**catalog,'articles':public},ensure_ascii=False).encode();mime='application/json; charset=utf-8'
        else:
            global_files={'index.html','read.html','app.css','catalog.css','catalog.js','reader.js'}
            member_files={'members.js','members.css','account.html','admin.html','favorites.html'}
            pieces=relative.split('/')
            valid=relative in global_files or (len(pieces)==2 and pieces[0]=='member-system' and pieces[1] in member_files)
            valid=valid or (len(pieces)==2 and pieces[0] in ('data','covers') and pieces[1].rsplit('.',1)[0] in allowed and re.fullmatch(r'[A-Za-z0-9_-]+\.(json|png|jpg|webp)',pieces[1]) is not None)
            valid=valid or (len(pieces)==3 and pieces[0]=='figures' and pieces[1] in allowed and re.fullmatch(r'[A-Za-z0-9_.-]+\.(png|jpe?g|webp)',pieces[2],re.I) is not None)
            target=(self.root/relative).resolve()
            if not valid or not target.is_relative_to(self.root) or not target.is_file():return fail()
            body=target.read_bytes();mime=mimetypes.guess_type(relative)[0] or 'application/octet-stream'
        start('200 OK',[('Content-Type',mime),('Content-Length',str(len(body))),('Cache-Control','no-store'),('X-Content-Type-Options','nosniff')]);return [body]
