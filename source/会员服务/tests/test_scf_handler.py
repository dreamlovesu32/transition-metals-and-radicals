import base64
import io
import json
import unittest
from unittest.mock import patch
import scf_handler as handler

class HandlerTests(unittest.TestCase):
    def setUp(self):self.old=handler._application
    def tearDown(self):handler._application=self.old
    def event(self,**changes):
        value={'httpMethod':'POST','path':'/api/member/login','headers':{'Content-Type':'application/json','Cookie':'opaque','X-Forwarded-For':'203.0.113.99'},'queryString':{'a':['1','2'],'unicode':'中文'},'body':'{"x":"中文"}','isBase64Encoded':False,'requestContext':{'sourceIp':'192.0.2.1'}}
        value.update(changes);return value
    def payload(self,result):return base64.b64decode(result['body'])
    def test_query_unicode_cookie_and_trusted_ip(self):
        seen=[]
        def app(env,start):
            seen.append(env);start('200 OK',[('Content-Type','application/json'),('Set-Cookie','session=opaque; Secure; HttpOnly')]);return [b'{}']
        handler._application=app;result=handler.main_handler(self.event(),None)
        self.assertEqual(200,result['statusCode']);env=seen[0]
        self.assertEqual('opaque',env['HTTP_COOKIE']);self.assertEqual('192.0.2.1',env['REMOTE_ADDR'])
        self.assertIn('a=1&a=2',env['QUERY_STRING']);self.assertEqual(len('{"x":"中文"}'.encode()),int(env['CONTENT_LENGTH']))
        self.assertEqual('session=opaque; Secure; HttpOnly',result['headers']['Set-Cookie']);self.assertNotIn('multiValueHeaders',result)
    def test_binary_request_and_raw_query(self):
        raw=b'\x00\xff\x80'
        env=handler._environment(self.event(body=base64.b64encode(raw).decode(),isBase64Encoded=True,queryString='a=1%2F2'))
        self.assertEqual(raw,env['wsgi.input'].read());self.assertEqual('a=1%2F2',env['QUERY_STRING'])
    def test_cloudbase_gateway_query_parameters(self):
        env=handler._environment(self.event(queryStringParameters={'q':'10.1021/jacs.9b10645'}))
        self.assertEqual('q=10.1021%2Fjacs.9b10645',env['QUERY_STRING'])
    def test_invalid_input_never_calls_app(self):
        def app(e,s):raise AssertionError('must not reach application')
        handler._application=app
        for changes in ({'body':'%%%','isBase64Encoded':True},{'body':{}},{'isBase64Encoded':'true'},{'headers':{'x':'a\r\nb'}},{'headers':{'cookie':'a','Cookie':'b'}}):
            with self.subTest(changes=changes):self.assertEqual(400,handler.main_handler(self.event(**changes),None)['statusCode'])
    def test_body_size_checked_before_application(self):
        for body,encoded in [('x'*32769,False),('中'*12000,False),(base64.b64encode(b'x'*32769).decode(),True)]:
            self.assertEqual(413,handler.main_handler(self.event(body=body,isBase64Encoded=encoded),None)['statusCode'])
    def test_invalid_source_ip_never_uses_forwarded_header(self):
        for context in ({},{'sourceIp':'not-an-ip'},None):self.assertEqual('unknown',handler._environment(self.event(requestContext=context))['REMOTE_ADDR'])
    def test_exception_and_factory_failure_do_not_expose_credentials(self):
        def app(e,s):raise RuntimeError('PASSWORD=should-never-appear')
        handler._application=app;result=handler.main_handler(self.event(),None)
        self.assertEqual(503,result['statusCode']);self.assertNotIn('PASSWORD',str(result))
        handler._application=None
        with patch.object(handler,'create_app',side_effect=RuntimeError('SECRET_DSN')):result=handler.main_handler(self.event(),None)
        self.assertNotIn('SECRET_DSN',str(result));self.assertEqual(503,result['statusCode'])
    def test_binary_private_image_and_iterable_closed(self):
        class Image:
            closed=False
            def __iter__(self):yield b'\x89PNG\x00\xff'
            def close(self):self.closed=True
        image=Image()
        def app(e,s):s('200 OK',[('Content-Type','image/png'),('Cache-Control','no-store')]);return image
        handler._application=app;result=handler.main_handler(self.event(httpMethod='GET',body=''),None)
        self.assertEqual(b'\x89PNG\x00\xff',self.payload(result));self.assertTrue(image.closed)
    def test_response_bounds_and_multiple_cookies_fail_closed(self):
        def app(e,s):s('200 OK',[('Set-Cookie','a=1'),('set-cookie','b=2')]);return [b'body']
        handler._application=app;self.assertEqual(503,handler.main_handler(self.event(),None)['statusCode'])
        def large(e,s):s('200 OK',[]);return [b'x'*(handler.MAX_RESPONSE_BYTES+1)]
        handler._application=large;self.assertEqual(b'{"error":"response_too_large"}',self.payload(handler.main_handler(self.event(),None)))

if __name__=='__main__':unittest.main()
