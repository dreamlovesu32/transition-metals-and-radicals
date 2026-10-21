const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../reader-chrome.js'),'utf8');
test('historical toolbar replaces the permanent preparing label with its read-only reason without enabling editing',()=>{
 const placeholder={disabled:true,title:'荧光笔正在准备',attrs:{}},banner={classList:{add(){}},dataset:{}},moved=[];
 const ctx={source:{querySelectorAll:selector=>selector==='.reader-historical-banner'?[banner]:[],querySelector:()=>null},annotationButton:null,penPlaceholder:placeholder,actions:{prepend:n=>moved.push(n)},dress(node,key,label){assert.equal(key,'pen');node.title=label;node.attrs['aria-label']=label;return node;}};
 vm.createContext(ctx);const start=source.indexOf('  function tidyMemberTools()'),end=source.indexOf('  if(source){',start);assert(start>=0&&end>start);vm.runInContext(source.slice(start,end),ctx);ctx.tidyMemberTools();
 assert.equal(placeholder.disabled,true);assert.match(placeholder.title,/历史版本只读/);assert.equal(placeholder.attrs['aria-label'],placeholder.title);assert(!placeholder.title.includes('准备'));assert.equal(moved[0],banner);
});
