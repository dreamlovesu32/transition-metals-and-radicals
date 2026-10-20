import base64
import hashlib
import json
import re
import uuid
from datetime import datetime, timezone

class ServiceError(Exception):
    def __init__(self, status, code):
        self.status, self.code = status, code
        super().__init__(code)

def bounded(value, maximum, empty=False):
    if not isinstance(value,str) or len(value)>maximum or (not empty and not value.strip()) or '\x00' in value:
        raise ServiceError(400,'invalid_input')
    return value

def identifier(value):
    if not isinstance(value,str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,100}',value):
        raise ServiceError(400,'invalid_identifier')
    return value

def version(value):
    if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{64}',value):
        raise ServiceError(400,'invalid_version')
    return value

def draft_hash(title,body,assets):
    content={'title':title,'body':body,'assets':{k:{'mime':v[0],'sha256':hashlib.sha256(v[1]).hexdigest()} for k,v in sorted(assets.items())}}
    return hashlib.sha256(json.dumps(content,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

class AssetBody:
    """Bounded streaming response owns one DB snapshot until WSGI closes it."""
    def __init__(self,transaction,tx,did,asset_id,mime,length):
        self.transaction,self.tx,self.did,self.asset_id,self.mime,self.length=transaction,tx,did,asset_id,mime,length
        self.closed=False
    def __iter__(self):
        try:
            start=1
            while True:
                row=self.tx.one('SELECT substr(payload,?,65536) AS chunk FROM assets WHERE draft_id=? AND id=?',(start,self.did,self.asset_id))
                chunk=row['chunk'] if row else ''
                if not chunk:break
                yield base64.b64decode(chunk,validate=True)
                start+=65536
        finally:self.close()
    def close(self):
        if not self.closed:
            self.closed=True;self.transaction.__exit__(None,None,None)

class MemberService:
    def __init__(self,store): self.store=store
    def _uid(self,uid): return bounded(uid,256)
    def _admin(self,tx,uid):
        if not tx.one('SELECT uid FROM admins WHERE uid=?',(self._uid(uid),)):
            raise ServiceError(403,'admin_required')
    def me(self,uid):
        with self.store.transaction() as tx:
            return {'uid':self._uid(uid),'admin':bool(tx.one('SELECT uid FROM admins WHERE uid=?',(uid,)))}
    def _article(self,tx,article_id):
        row=tx.one('SELECT * FROM articles WHERE id=? AND published=1',(identifier(article_id),))
        if not row: raise ServiceError(404,'article_not_found')
        return row
    def favorites(self,uid):
        with self.store.transaction() as tx:
            return tx.all('SELECT f.article_id,f.created_at FROM favorites f JOIN articles a ON a.id=f.article_id WHERE f.uid=? AND a.published=1 ORDER BY f.created_at ASC',(self._uid(uid),))
    def favorite(self,uid,article_id,enabled):
        with self.store.transaction() as tx:
            self._article(tx,article_id); self._uid(uid)
            if enabled: tx.execute('INSERT INTO favorites(uid,article_id,created_at) VALUES (?,?,?) ON CONFLICT(uid,article_id) DO NOTHING',(uid,article_id,datetime.now(timezone.utc).isoformat()))
            else: tx.execute('DELETE FROM favorites WHERE uid=? AND article_id=?',(uid,article_id))
        return {'article_id':article_id,'favorited':enabled}
    def notes(self,uid,article_id):
        with self.store.transaction() as tx:
            if article_id is None:
                return tx.all('SELECT n.id,n.article_id,n.version_hash,n.anchor,n.quote,n.text,(SELECT r.client_id FROM note_requests r WHERE r.note_id=n.id AND r.uid=n.uid) AS client_id FROM notes n JOIN articles a ON a.id=n.article_id WHERE n.uid=? AND a.published=1',(self._uid(uid),))
            self._article(tx,article_id)
            return tx.all('SELECT n.id,n.article_id,n.version_hash,n.anchor,n.quote,n.text,(SELECT r.client_id FROM note_requests r WHERE r.note_id=n.id AND r.uid=n.uid) AS client_id FROM notes n WHERE n.uid=? AND n.article_id=?',(self._uid(uid),article_id))
    def add_note(self,uid,data):
        uid=self._uid(uid); aid=identifier(data.get('article_id')); vh=version(data.get('version_hash'))
        anchor=bounded(data.get('anchor'),500); quote=bounded(data.get('quote',''),2000,True); text=bounded(data.get('text',''),10000,True)
        if not text.strip() and not quote.strip():raise ServiceError(400,'empty_note')
        client_id=identifier(data['client_id']) if data.get('client_id') is not None else None
        request_hash=hashlib.sha256(json.dumps([aid,vh,anchor,quote,text],ensure_ascii=False,separators=(',',':')).encode()).hexdigest()
        with self.store.transaction() as tx:
            article=self._article(tx,aid)
            prior=tx.one('SELECT note_id,request_hash FROM note_requests WHERE uid=? AND client_id=?',(uid,client_id)) if client_id else None
            if prior:
                if prior['request_hash']!=request_hash:raise ServiceError(409,'idempotency_conflict')
                existing=tx.one('SELECT id,article_id,version_hash,anchor,quote,text FROM notes WHERE id=? AND uid=?',(prior['note_id'],uid))
                if not existing:raise ServiceError(409,'note_deleted')
                return {**existing,'client_id':client_id}
            if article['version_hash']!=vh: raise ServiceError(409,'version_mismatch')
            nid=uuid.uuid4().hex
            tx.execute('INSERT INTO notes VALUES (?,?,?,?,?,?,?)',(nid,uid,aid,vh,anchor,quote,text))
            if client_id:tx.execute('INSERT INTO note_requests VALUES (?,?,?,?)',(uid,client_id,nid,request_hash))
        return {'id':nid,'client_id':client_id,'article_id':aid,'version_hash':vh,'anchor':anchor,'quote':quote,'text':text}
    def delete_note(self,uid,nid):
        with self.store.transaction() as tx:
            row=tx.one('SELECT article_id FROM notes WHERE id=? AND uid=?',(identifier(nid),self._uid(uid)))
            if not row: raise ServiceError(404,'note_not_found')
            tx.execute('DELETE FROM notes WHERE id=? AND uid=?',(nid,uid))
        return {'deleted':True}
    def drafts(self,uid):
        with self.store.transaction() as tx:
            self._admin(tx,uid)
            return tx.all('SELECT id,title,version_hash FROM drafts')
    def draft(self,uid,did):
        with self.store.transaction() as tx:
            self._admin(tx,uid)
            row=tx.one('SELECT * FROM drafts WHERE id=?',(identifier(did),))
            if not row: raise ServiceError(404,'draft_not_found')
            row['assets']=tx.all('SELECT id,mime,version_hash FROM assets WHERE draft_id=?',(did,))
            row['feedback']=self._feedback_records(tx,did)
            row['reviews']=tx.all('SELECT uid,version_hash,decision,comment,created_at FROM reviews WHERE draft_id=?',(did,))
            return row
    def export_plan(self,uid,did,source,vh,plan=None):
        with self.store.transaction() as tx:
            self._admin(tx,uid)
            row=tx.one('SELECT version_hash FROM drafts WHERE id=?',(identifier(did),))
            if source=='static':
                version(vh)
                public=self._article(tx,did)
                if public['version_hash']!=vh:raise ServiceError(409,'version_mismatch')
            elif not row or row['version_hash']!=vh:raise ServiceError(409,'version_mismatch')
            if plan is not None:
                tx.execute('INSERT INTO export_plans VALUES (?,?,?,?) ON CONFLICT(draft_id,source) DO UPDATE SET version_hash=excluded.version_hash,plan=excluded.plan',(did,source,vh,json.dumps(plan,ensure_ascii=False)))
            saved=tx.one('SELECT plan FROM export_plans WHERE draft_id=? AND source=? AND version_hash=?',(did,source,vh))
            return {'plan':json.loads(saved['plan']) if saved else None}
    def asset(self,uid,did,asset_id):
        with self.store.transaction() as tx:
            self._admin(tx,uid)
            row=tx.one('SELECT a.mime,a.payload FROM assets a JOIN drafts d ON a.draft_id=d.id AND a.version_hash=d.version_hash WHERE a.draft_id=? AND a.id=?',(identifier(did),identifier(asset_id)))
            if not row: raise ServiceError(404,'asset_not_found')
            return row['mime'],base64.b64decode(row['payload'],validate=True)
    def asset_stream(self,uid,did,asset_id):
        transaction=self.store.transaction();tx=transaction.__enter__()
        try:
            self._admin(tx,uid)
            row=tx.one('SELECT a.mime,LENGTH(a.payload) AS encoded_size,substr(a.payload,LENGTH(a.payload)-1,2) AS tail FROM assets a JOIN drafts d ON a.draft_id=d.id AND a.version_hash=d.version_hash WHERE a.draft_id=? AND a.id=?',(identifier(did),identifier(asset_id)))
            if not row:raise ServiceError(404,'asset_not_found')
            padding=2 if row['tail']=='==' else 1 if row['tail'].endswith('=') else 0
            return AssetBody(transaction,tx,did,asset_id,row['mime'],row['encoded_size']//4*3-padding)
        except BaseException:
            import sys
            transaction.__exit__(*sys.exc_info());raise
    def review(self,uid,did,data):
        vh=version(data.get('version_hash')); decision=data.get('decision'); comment=bounded(data.get('comment',''),10000,True)
        if decision not in ('approved','changes_requested'): raise ServiceError(400,'invalid_decision')
        with self.store.transaction() as tx:
            self._admin(tx,uid)
            draft=tx.one('SELECT version_hash FROM drafts WHERE id=?',(identifier(did),))
            if not draft: raise ServiceError(404,'draft_not_found')
            if draft['version_hash']!=vh: raise ServiceError(409,'stale_review')
            rid=uuid.uuid4().hex
            tx.execute('INSERT INTO reviews VALUES (?,?,?,?,?,?,?)',(rid,uid,did,vh,decision,comment,datetime.now(timezone.utc).isoformat()))
        return {'id':rid,'version_hash':vh,'decision':decision,'published':False}
    def feedback(self,uid,did,data):
        vh=version(data.get('version_hash')); target=data.get('target',{})
        if not isinstance(target,dict) or target.get('type') not in ('article','paragraph','figure'): raise ServiceError(400,'invalid_target')
        target_id=bounded(target.get('id',did),500)
        comment=bounded(data.get('comment'),10000); quote=bounded(data.get('quote',''),2000,True)
        with self.store.transaction() as tx:
            self._admin(tx,uid)
            draft=tx.one('SELECT version_hash FROM drafts WHERE id=?',(identifier(did),))
            if not draft: raise ServiceError(404,'draft_not_found')
            if draft['version_hash']!=vh: raise ServiceError(409,'stale_feedback')
            fid=uuid.uuid4().hex
            tx.execute('INSERT INTO feedback VALUES (?,?,?,?,?,?,?,?,?)',(fid,uid,did,vh,target['type'],target_id,quote,comment,datetime.now(timezone.utc).isoformat()))
        return {'id':fid,'version_hash':vh,'target':target,'comment':comment}
    def _feedback_records(self,tx,did):
        records=tx.all('SELECT * FROM feedback WHERE draft_id=? ORDER BY created_at,id',(did,))
        for record in records:
            edit=tx.one('SELECT comment,revision,created_at FROM feedback_edits WHERE feedback_id=? ORDER BY revision DESC LIMIT 1',(record['id'],))
            record['edit_revision']=edit['revision'] if edit else 0
            if edit:record.update(comment=edit['comment'],edited_at=edit['created_at'])
        return records
    def edit_feedback(self,uid,did,fid,data):
        vh=version(data.get('version_hash'));comment=bounded(data.get('comment'),10000)
        revision=data.get('edit_revision')
        if type(revision) is not int or revision<0:raise ServiceError(400,'invalid_revision')
        with self.store.transaction() as tx:
            self._admin(tx,uid)
            draft=tx.one('SELECT version_hash FROM drafts WHERE id=?',(identifier(did),))
            if not draft:raise ServiceError(404,'draft_not_found')
            if draft['version_hash']!=vh:raise ServiceError(409,'stale_feedback')
            record=tx.one('SELECT * FROM feedback WHERE id=? AND draft_id=?',(identifier(fid),did))
            if not record:raise ServiceError(404,'feedback_not_found')
            if record['uid']!=uid:raise ServiceError(403,'feedback_owner_required')
            if record['version_hash']!=vh:raise ServiceError(409,'stale_feedback')
            latest=tx.one('SELECT MAX(revision) AS revision FROM feedback_edits WHERE feedback_id=?',(fid,))['revision'] or 0
            if latest!=revision:raise ServiceError(409,'feedback_conflict')
            stamp=datetime.now(timezone.utc).isoformat()
            tx.execute('INSERT INTO feedback_edits VALUES (?,?,?,?,?,?)',(uuid.uuid4().hex,fid,uid,revision+1,comment,stamp))
        return {**record,'comment':comment,'edit_revision':revision+1,'edited_at':stamp}
    def get_progress(self,uid,aid):
        with self.store.transaction() as tx:
            self._article(tx,aid)
            row=tx.one('SELECT version_hash,position,revision,updated_at FROM progress WHERE uid=? AND article_id=?',(self._uid(uid),aid))
            if row: row['position']=json.loads(row['position'])
            return row or {'revision':0,'position':None,'version_hash':None,'updated_at':None}
    def put_progress(self,uid,aid,data):
        vh=version(data.get('version_hash')); expected=data.get('revision')
        if type(expected) is not int or expected<0: raise ServiceError(400,'invalid_revision')
        position=data.get('position')
        if not isinstance(position,dict): raise ServiceError(400,'invalid_position')
        encoded=json.dumps(position,ensure_ascii=False,separators=(',',':'))
        if len(encoded)>4000: raise ServiceError(400,'invalid_position')
        with self.store.transaction() as tx:
            article=self._article(tx,aid); self._uid(uid)
            if article['version_hash']!=vh: raise ServiceError(409,'version_mismatch')
            row=tx.one('SELECT revision FROM progress WHERE uid=? AND article_id=?',(uid,aid))
            current=row['revision'] if row else 0
            if current!=expected: raise ServiceError(409,'progress_conflict')
            updated=datetime.now(timezone.utc).isoformat()
            tx.execute('INSERT INTO progress VALUES (?,?,?,?,?,?) ON CONFLICT(uid,article_id) DO UPDATE SET version_hash=excluded.version_hash,position=excluded.position,revision=excluded.revision,updated_at=excluded.updated_at',(uid,aid,vh,encoded,current+1,updated))
        return {'version_hash':vh,'position':position,'revision':current+1,'updated_at':updated}
    def events(self,uid,after='',after_id=''):
        with self.store.transaction() as tx:
            self._admin(tx,uid)
            return self.trusted_export_events(tx,after,after_id)
    def trusted_export_events(self,tx,after='',after_id=''):
        # Explicit trusted operator path, never routed without admin authentication.
        bounded(after,100,True);bounded(after_id,100,True)
        rows=tx.all("SELECT * FROM (SELECT id,uid,draft_id,version_hash,decision AS event_type,comment,created_at,'' AS target_type,'' AS target_id,'' AS quote,NULL AS feedback_id,0 AS edit_revision FROM reviews UNION ALL SELECT id,uid,draft_id,version_hash,'feedback' AS event_type,comment,created_at,target_type,target_id,quote,NULL,0 FROM feedback UNION ALL SELECT e.id,e.uid,f.draft_id,f.version_hash,'feedback_edit',e.comment,e.created_at,f.target_type,f.target_id,f.quote,f.id,e.revision FROM feedback_edits e JOIN feedback f ON f.id=e.feedback_id) AS event_rows WHERE created_at>? OR (created_at=? AND id>?) ORDER BY created_at,id LIMIT 200",(after,after,after_id))
        for row in rows:
            if row['feedback_id'] is None:row.pop('feedback_id');row.pop('edit_revision')
        return {'events':rows,'cursor':{'after':rows[-1]['created_at'],'after_id':rows[-1]['id']} if rows else {'after':after,'after_id':after_id}}
    # Trusted ingestion only: no HTTP route, no publishing side effect.
    def import_draft(self,did,title,body,assets,approval_hash=None):
        identifier(did); bounded(title,500); bounded(body,200000)
        if len(assets)>100: raise ServiceError(400,'too_many_assets')
        for key,(mime,payload) in assets.items():
            identifier(key)
            if mime not in ('image/png','image/jpeg','image/webp') or not isinstance(payload,bytes) or len(payload)>20*1024*1024:
                raise ServiceError(400,'invalid_asset')
        vh=version(approval_hash) if approval_hash is not None else draft_hash(title,body,assets)
        with self.store.transaction() as tx:
            tx.execute('INSERT INTO drafts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET version_hash=excluded.version_hash,title=excluded.title,body=excluded.body',(did,vh,title,body))
            tx.execute('DELETE FROM assets WHERE draft_id=?',(did,))
            for key,(mime,payload) in assets.items(): tx.execute('INSERT INTO assets VALUES (?,?,?,?,?)',(did,key,vh,mime,base64.b64encode(payload).decode()))
        return vh
