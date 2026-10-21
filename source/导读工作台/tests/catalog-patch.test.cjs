const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
class Node{
 constructor(tag){this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.style={};this.listeners={};this.scrollLeft=0;this.isConnected=true;this.className='';this.classList={contains:c=>this.className.split(' ').includes(c)};}
 append(...nodes){nodes.forEach(n=>this.insertBefore(n,null));}
 insertBefore(n,before){if(n.parentElement)n.parentElement.children=n.parentElement.children.filter(x=>x!==n);n.parentElement=this;const i=before?this.children.indexOf(before):-1;i<0?this.children.push(n):this.children.splice(i,0,n);}
 replaceWith(n){const p=this.parentElement;p.insertBefore(n,this);this.remove();}
 remove(){this.isConnected=false;if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);}
 get firstElementChild(){return this.children[0];}
 set textContent(v){this.text=String(v);this.children=[];}get textContent(){return this.text||this.children.map(n=>n.textContent).join('');}
 setAttribute(k,v){this.attrs[k]=String(v);}getAttribute(k){return this.attrs[k]??null;}removeAttribute(k){delete this.attrs[k];}
 addEventListener(k,fn){this.listeners[k]=fn;}
 contains(n){return this===n||this.children.some(x=>x.contains(n));}
 querySelectorAll(selector){const parts=selector.split(' '),matches=(n,s)=>s.startsWith('.')?n.className.split(' ').includes(s.slice(1)):n.tagName===s;let result=[];for(const child of this.children){if(matches(child,parts[0]))result.push(...(parts.length===1?[child]:child.querySelectorAll(parts.slice(1).join(' '))));result.push(...child.querySelectorAll(selector));}return [...new Set(result)];}
 querySelector(s){return this.querySelectorAll(s)[0]||null;}
 focus(){this.document.activeElement=this;}
}
function harness(){
 const map=new Map(),document={activeElement:null,readyState:'complete',createElement(tag){const n=new Node(tag);n.document=document;return n;},querySelector(s){return map.get(s)||null;},addEventListener(){},querySelectorAll(){return [];}};
 const make=(key,cls='')=>{const n=document.createElement('div');n.className=cls;map.set(key,n);return n;};
 const sort=make('#catalog-sort');sort.value='updated';make('.catalog-main');
 for(const kind of ['research','review']){const section=make('#'+kind,'is-expanded');make('#'+kind+'-list');make('#'+kind+'-count');make('#'+kind+'-empty');for(const c of ['catalog-track-shell','catalog-expand','catalog-arrow-prev','catalog-arrow-next']){const n=document.createElement('div');n.className=c;section.append(n);}}
 let prepare=0,cover=0;const ctx={document,URL,Date,Intl,requestAnimationFrame:fn=>fn(),ReadMedia:{cover(img,a){cover++;img.dataset.src=a.coverDisplay||a.cover;},prepare(){prepare++;}},ReadMembers:{setPublicCatalog(){}}};ctx.window=ctx;vm.createContext(ctx);
 const root=path.resolve(__dirname,'..');vm.runInContext(fs.readFileSync(path.join(root,'card-actions.js'),'utf8'),ctx);
 const source=fs.readFileSync(path.join(root,'catalog.js'),'utf8');vm.runInContext(source.slice(0,source.indexOf('$("#catalog-sort").addEventListener'))+'\n'+source.slice(source.indexOf('function prepareCovers(')),ctx);
 return {ctx,document,map,render(rows){ctx.inputRows=rows;vm.runInContext('catalogArticles=inputRows;renderCatalog()',ctx);},get cover(){return cover;},get prepare(){return prepare;}};
}
test('late metadata/New patch retains image, loaded state, focus, expanded track and scroll; publication enables favorite',()=>{
 const h=harness(),article={id:'synthetic',kind:'research',readingId:'r1',title:'Initial',journal:'Journal',published:'2024.01',doi:'10.1000/fixture',cover:'cover.png',public:false,updatedAt:'2020-01-01T00:00:00Z'};
 for(const kind of ['research','review'])for(let i=0;i<3;i++){const skeleton=h.document.createElement('article');skeleton.className='catalog-card catalog-skeleton';h.map.get('#'+kind+'-list').append(skeleton);}
 h.render([article]);assert.equal(h.map.get('#research-list').children.length,1);assert.equal(h.map.get('#review-list').children.length,0);const track=h.map.get('#research-list'),card=track.children[0],image=card.querySelector('img'),favorite=card.querySelector('.card-favorite');assert(favorite.disabled);
 image.setAttribute('src','already-loaded');image.dataset.decoded='true';track.scrollLeft=241;h.document.activeElement=favorite;
 const updated={...article,public:true,title:'Updated',updatedAt:new Date().toISOString()};h.render([updated]);
 assert.equal(track.children[0],card);assert.equal(card.querySelector('img'),image);assert.equal(image.getAttribute('src'),'already-loaded');assert.equal(image.dataset.decoded,'true');assert.equal(h.cover,1);assert.equal(track.scrollLeft,241);assert.equal(h.document.activeElement,favorite);assert(h.map.get('#research').classList.contains('is-expanded'));assert(!favorite.disabled);
 const badge=card.querySelector('.card-new');assert.equal(badge.parentElement.className,'card-date');assert(!card.querySelector('.catalog-cover').contains(badge));assert.equal(card.querySelector('h3').textContent,'Updated');
 h.render([updated]);assert.equal(card.querySelectorAll('.card-new').length,1);
 favorite.disabled=true;favorite.setAttribute('aria-busy','true');h.render([{...updated,updatedAt:article.updatedAt}]);assert.equal(card.querySelector('.card-new'),null);assert(favorite.disabled,'metadata must not override an in-flight favorite');
});
