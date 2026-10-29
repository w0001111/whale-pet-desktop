import test from 'node:test';
import assert from 'node:assert/strict';
import {isPublicAddress,publicWebUrl,createWebReader,createReadOnlyWebTools,extractPage} from './web-tools.mjs';
const publicDNS=async()=>[{address:'8.8.8.8',family:4}];
test('read-only web tools exclude private, loopback, mapped and special-use IPs and non-web URLs',()=>{
  for(const address of ['127.0.0.1','10.0.0.1','169.254.169.254','192.168.1.1','198.18.0.1','::1','::ffff:127.0.0.1','fc00::1','fe80::1','2001:2::1','2001:db8::1','3fff::1'])assert.equal(isPublicAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPublicAddress(address),true,address);
  for(const url of ['file:///etc/passwd','http://localhost/','http://127.1/','http://2130706433/','http://[::1]/','https://user:password@example.com/','https://example.com:8443/'])assert.throws(()=>publicWebUrl(url),{code:'URL_BLOCKED'});
});
test('each redirect is checked before a pinned connection and mixed DNS never reaches the network',async()=>{
  const connections=[];
  const reader=createWebReader({lookup:publicDNS,request:async(url,address)=>{connections.push([url.href,address.address]);return{status:302,location:'http://127.0.0.1/secret'};}});
  await assert.rejects(reader('https://example.com/'),{code:'URL_BLOCKED'});assert.deepEqual(connections,[['https://example.com/','8.8.8.8']]);
  await assert.rejects(createWebReader({lookup:async()=>[{address:'8.8.8.8',family:4},{address:'10.0.0.1',family:4}],request:async()=>{throw new Error('must not connect');}})('https://example.com/'),{code:'DNS_BLOCKED'});
});
test('Fake-IP resolution fallback still validates and pins a real public address',async()=>{
  const connections=[];
  const options={lookup:async()=>[{address:'198.18.0.40',family:4}],request:async(_url,address)=>{connections.push(address.address);return{status:200,body:'public text'};}};
  const reader=createWebReader({...options,dnsFallback:async()=>[{address:'1.1.1.1',family:4}]});await reader('https://example.com/');assert.deepEqual(connections,['1.1.1.1']);
  await assert.rejects(createWebReader({...options,dnsFallback:async()=>[{address:'127.0.0.1',family:4}]})('https://example.com/'),{code:'DNS_BLOCKED'});
});
test('web requests have independent deadline, body and redirect bounds',async()=>{
  await assert.rejects(createWebReader({lookup:()=>new Promise(()=>{}),requestLimits:{timeoutMs:10}})('https://example.com/'),{code:'WEB_TIMEOUT'});
  await assert.rejects(createWebReader({lookup:publicDNS,requestLimits:{bytes:8},request:async()=>({status:200,body:'123456789'})})('https://example.com/'),{code:'WEB_TOO_LARGE'});
  let requests=0;await assert.rejects(createWebReader({lookup:publicDNS,request:async()=>{requests++;return{status:301,location:'/again'};}})('https://example.com/'),{code:'WEB_REDIRECT_LIMIT'});assert.equal(requests,4);
});
test('page extraction excludes scripts and marks links as unread rather than claiming target content',()=>{
  const page=extractPage({sourceUrl:'https://example.com/',headers:{'content-type':'text/html'},body:'<title>Test &amp; title</title><script>private script</script><p>实际正文</p><a href="/next">下页</a><a href="http://localhost/">不可访问</a>'});
  assert.equal(page.title,'Test & title');assert.ok(page.text.includes('实际正文'));assert.equal(page.text.includes('private script'),false);assert.deepEqual(page.links,[{title:'下页',url:'https://example.com/next',visited:false}]);
});
test('search returns only actually fetched RSS results and reports a captcha honestly',async()=>{
  const run=createReadOnlyWebTools({reader:async url=>({sourceUrl:url,body:'<rss><item><title>Actual result</title><link>https://example.com/post</link><description>Fetched snippet</description></item></rss>'})});
  const value=await run('search_web',{query:'test'});assert.equal(value.results.length,1);assert.equal(value.results[0].visited,false);assert.ok(value.note.includes('正文尚未访问'));
  await assert.rejects(createReadOnlyWebTools({reader:async url=>({sourceUrl:url,body:'<html>captcha</html>'})})('search_web',{query:'test'}),{code:'SEARCH_UNAVAILABLE'});
  await assert.rejects(run('shell',{command:'anything'}),{code:'UNKNOWN_TOOL'});
});
