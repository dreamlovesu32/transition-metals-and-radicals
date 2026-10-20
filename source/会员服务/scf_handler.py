"""Tencent API Gateway integration adapter; no deployment or IAM side effects."""
import base64
import binascii
import io
import ipaddress
from urllib.parse import urlencode
from member_service.runtime import create_app

_application=None
MAX_REQUEST_BYTES=32768
MAX_RESPONSE_BYTES=4*1024*1024

def _response(status,payload=b'{"error":"service_unavailable"}',headers=None):
    return {'statusCode':status,'headers':headers or {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},'isBase64Encoded':True,'body':base64.b64encode(payload).decode('ascii')}

def _environment(event):
    if not isinstance(event,dict):raise ValueError('event')
    raw_headers=event.get('headers') or {}
    if not isinstance(raw_headers,dict):raise ValueError('headers')
    headers={}
    for key,value in raw_headers.items():
        if not isinstance(key,str) or not isinstance(value,str) or '\r' in key+value or '\n' in key+value:raise ValueError('header')
        lower=key.lower()
        if lower in headers:raise ValueError('duplicate_header')
        headers[lower]=value
    if sum(len(k)+len(v) for k,v in headers.items())>32768:raise OverflowError('headers')
    body=event.get('body','')
    if body is None:body=''
    if not isinstance(body,str):raise ValueError('body')
    encoded=event.get('isBase64Encoded',False)
    if type(encoded) is not bool:raise ValueError('base64_flag')
    if encoded:
        if len(body)>4*((MAX_REQUEST_BYTES+2)//3):raise OverflowError('body')
        raw=base64.b64decode(body,validate=True)
    else:
        if len(body)>MAX_REQUEST_BYTES:raise OverflowError('body')
        raw=body.encode('utf-8')
    if len(raw)>MAX_REQUEST_BYTES:raise OverflowError('body')
    query=event.get('queryStringParameters', event.get('queryString','')) or ''
    if isinstance(query,dict):query=urlencode(query,doseq=True)
    if not isinstance(query,str) or len(query)>8192:raise ValueError('query')
    path=event.get('path','/');method=event.get('httpMethod','GET')
    if not isinstance(path,str) or not path.startswith('/') or len(path)>2048 or not isinstance(method,str):raise ValueError('route')
    context=event.get('requestContext') or {}
    # This field belongs to the trusted gateway event, never client XFF headers.
    candidate=context.get('sourceIp','unknown') if isinstance(context,dict) else 'unknown'
    try:source=str(ipaddress.ip_address(candidate))
    except (ValueError,TypeError):source='unknown'
    env={'REQUEST_METHOD':method.upper(),'PATH_INFO':path,'QUERY_STRING':query,'CONTENT_TYPE':headers.get('content-type',''),'CONTENT_LENGTH':str(len(raw)),'wsgi.input':io.BytesIO(raw),'wsgi.version':(1,0),'wsgi.errors':io.StringIO(),'wsgi.multithread':False,'wsgi.multiprocess':False,'wsgi.run_once':False,'wsgi.url_scheme':'https','SERVER_NAME':'localhost','SERVER_PORT':'443','SERVER_PROTOCOL':'HTTP/1.1','REMOTE_ADDR':source}
    for key,value in headers.items():
        if key not in ('content-type','content-length'):env['HTTP_'+key.upper().replace('-','_')]=value
    return env

def main_handler(event,context):
    global _application
    try:
        try:env=_environment(event)
        except OverflowError:return _response(413,b'{"error":"request_too_large"}')
        except (ValueError,TypeError,UnicodeError,binascii.Error):return _response(400,b'{"error":"invalid_request"}')
        if _application is None:_application=create_app()
        response=[]
        def start(status,headers,exc_info=None):
            if response:raise ValueError('duplicate_start_response')
            response.append((status,headers))
        iterable=_application(env,start)
        try:
            chunks=[];total=0
            for chunk in iterable:
                if not isinstance(chunk,bytes):raise ValueError('invalid_wsgi_body')
                total+=len(chunk)
                if total>MAX_RESPONSE_BYTES:return _response(503,b'{"error":"response_too_large"}')
                chunks.append(chunk)
            raw=b''.join(chunks)
        finally:
            if hasattr(iterable,'close'):iterable.close()
        if len(response)!=1:raise ValueError('missing_start_response')
        status,headers=response[0];out={};seen=set()
        for name,value in headers:
            if not isinstance(name,str) or not isinstance(value,str) or '\r' in name+value or '\n' in name+value:raise ValueError('invalid_response_header')
            lower=name.lower()
            if lower in seen:raise ValueError('duplicate_response_header')
            seen.add(lower);out[name]=value
        # Official integration response uses string headers, including one Set-Cookie.
        # Multiple cookies fail closed rather than silently losing a security cookie.
        return _response(int(status.split()[0]),raw,out)
    except Exception:
        return _response(503)
