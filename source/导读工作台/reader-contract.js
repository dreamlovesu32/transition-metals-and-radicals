/* Versioned, pure reading-plan compiler. Does not modify article snapshots. */
(function(root) {
 "use strict";
 function compile(article, blocks) {
  const has = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
  const object = o => o && typeof o === "object" && !Array.isArray(o);
  const allowed = (o, keys) => object(o) && Object.keys(o).every(k=>keys.includes(k));
  const fraction = (v, name, open=false) => {if(typeof v!=="number" || !Number.isFinite(v) || (open ? v<=0||v>=1 : v<0||v>1))throw new Error(`Invalid ${name}`);return v;};
  const config = has(article,"reading") ? article.reading : {};
  if(!allowed(config,["version","downThreshold","upBuffer","endBuffer","switches"]) || (has(article,"reading") && config.version!==1))throw new Error("Invalid reading settings/version");
  const overrides = has(config,"switches") ? config.switches : [];
  if(!Array.isArray(overrides) || !Array.isArray(blocks) || !blocks.length)throw new Error("Invalid reading blocks/switches");
  const result = {version:1,downThreshold:fraction(has(config,"downThreshold") ? config.downThreshold : has(article,"scrollThreshold") ? article.scrollThreshold : .52,"downThreshold",true),upBuffer:fraction(has(config,"upBuffer") ? config.upBuffer : .18,"upBuffer"),endBuffer:fraction(has(config,"endBuffer") ? config.endBuffer : .25,"endBuffer"),switches:[]};
  const ids=new Set(), figures=[];
  // Full manifests have figures; API snapshots expose the same allowed assets as figurePages.
  const assets=new Set(article.figures ? article.figures.map(f=>`figures/${f.file}`) : Object.keys(article.figurePages || {}));
  for(const block of blocks){
   if(!object(block)||typeof block.id!=="string"||!block.id.trim()||ids.has(block.id))throw new Error("Missing or duplicate block id");
   ids.add(block.id);
   if(!["title","heading","paragraph","figure","bullet","number","quote","table"].includes(block.kind))throw new Error("Unsupported block kind");
   if(block.kind==="heading"&&(!Number.isInteger(has(block,"level")?block.level:2)||(block.level??2)<2||(block.level??2)>4))throw new Error("Invalid heading level");
   if(block.kind==="figure"){if(!assets.has(block.src))throw new Error("Unlisted figure asset");figures.push(block);}
   else if(has(block,"scrollTrigger"))throw new Error("Invalid scrollTrigger");
  }
  if(!figures.length)throw new Error("Article requires figures");
  const figureIds=new Set(figures.map(b=>b.id)), byId=new Map(), last=figures.at(-1).id;
  for(const item of overrides){
   if(!allowed(item,["figureId","trigger","anchorId"])||!figureIds.has(item.figureId)||byId.has(item.figureId)||!["block","article-end"].includes(item.trigger))throw new Error("Invalid figure switch");
   if(item.trigger==="article-end"&&(item.figureId!==last||has(item,"anchorId")))throw new Error("article-end requires final figure without anchor");
   if(item.trigger==="block"&&!ids.has(has(item,"anchorId") ? item.anchorId : item.figureId))throw new Error("Unknown anchorId");
   byId.set(item.figureId,item);
  }
  result.switches=figures.map(block=>{
   if(block.scrollTrigger!=null&&(block.scrollTrigger!=="article-end"||block.id!==last))throw new Error("Invalid legacy trigger");
   const item=byId.get(block.id)||{trigger:block.scrollTrigger||"block"};
   const entry={figureId:block.id,trigger:item.trigger};
   if(item.trigger==="block")entry.anchorId=has(item,"anchorId") ? item.anchorId : block.id;
   return entry;
  });
  return result;
 }
 const api=Object.freeze({compile});
 if(typeof module!=="undefined"&&module.exports)module.exports=api;
 root.ReadArticle=api;
})(typeof window!=="undefined"?window:globalThis);
