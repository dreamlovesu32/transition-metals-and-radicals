/* Recover the member resource without page reloads or unverified identity. */
(function(global){
  'use strict';let flight=null,domReady=document.readyState==='complete';const domFinished=domReady?Promise.resolve():new Promise(resolve=>document.addEventListener('DOMContentLoaded',()=>{domReady=true;resolve();},{once:true}));const assetRoot=new URL('./',document.currentScript?.src||location.href);
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function ensure(){
    if(global.ReadMembers)return global.ReadMembers;if(flight)return flight;
    flight=(async()=>{
      if(!domReady)await domFinished;if(global.ReadMembers)return global.ReadMembers;
      const original=[...document.scripts].find(script=>/\/member-system\/members\.js(?:[?#]|$)/.test(script.src));
      const url=original?.src||new URL('member-system/members.js',assetRoot).href;
      for(let attempt=0;!global.ReadMembers;attempt++){
        try{
          const response=await fetch(url,{credentials:'same-origin',cache:'no-cache'});
          if(!response.ok)throw {kind:'http',status:response.status,code:'member_resource_unavailable'};
          if(global.ReadMembers)break;
          if(/text\/html/i.test(response.headers.get('Content-Type')||''))throw {kind:'protocol',status:200,code:'member_resource_invalid'};
          await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=url+(url.includes('?')?'&':'?')+'resource-recovery='+attempt;script.onload=resolve;script.onerror=()=>reject({kind:'resource',code:'member_resource_unavailable'});document.head.append(script);});
          if(!global.ReadMembers)throw {kind:'resource',code:'member_resource_invalid'};
        }catch(error){
          const network=global.navigator?.onLine===false;
          if(network)global.ReadToast?.show({key:'member-resource',kind:'info',message:'因网络问题暂时未连接，恢复后会自动完成。'});
          if(attempt===0)global.console?.warn?.('Read resource diagnostic',{scope:'members-script',status:error.status||0,category:error.kind||'transport',code:error.code||'resource_transport'});
          await wait(Math.min(60000,1000*2**Math.min(attempt,6)));
        }
      }
      document.dispatchEvent(new CustomEvent('read-members-available'));return global.ReadMembers;
    })();return flight;
  }
  global.ReadEnsureMembers=ensure;
  document.addEventListener('error',event=>{if(event.target?.tagName==='SCRIPT'&&/\/member-system\/members\.js(?:[?#]|$)/.test(event.target.src))void ensure();},true);
  document.addEventListener('DOMContentLoaded',()=>{if(!global.ReadMembers)void ensure();},{once:true});
})(window);
