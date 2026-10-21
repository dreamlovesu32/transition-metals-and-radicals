/* One escaped inline formatter for the reader, review text and material export. */
(function(global){
 'use strict';
 function escape(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
 function compact(out){
  // Operate on visible text only: formatting tags and URL attributes stay intact.
  const tokens=out.match(/<[^>]*>|&(?:#[0-9]+|#x[a-f0-9]+|[a-z]+);|[\s\S]/giu)||[];
  const visible=[];let codeDepth=0;
  tokens.forEach((token,index)=>{
   if(token[0]==='<'){
    if(/^<code\b/i.test(token))codeDepth++;
    else if(/^<\/code>/i.test(token))codeDepth=Math.max(0,codeDepth-1);
    else if(/^<br\b/i.test(token))visible.push({char:'\n',index,code:false});
    return;
   }
   const entity=/^&#(?:x([a-f0-9]+)|([0-9]+));$/i.exec(token);
   const char=entity?String.fromCodePoint(parseInt(entity[1]||entity[2],entity[1]?16:10)):token;
   visible.push({char,index,code:codeDepth>0});
  });
  const space=char=>/^[\t \u00a0\u3000]$/u.test(char||'');
  const han=char=>/^\p{Script=Han}$/u.test(char||'');
  const latinNumber=char=>/^[\p{Script=Latin}\p{Number}]$/u.test(char||'');
  for(let i=0;i<visible.length;){
   if(!space(visible[i].char)){i++;continue;}
   let end=i;while(end<visible.length&&space(visible[end].char))end++;
   const before=visible[i-1]?.char,after=visible[end]?.char;
   const latinSuffix=(before==='%'||before==='*'||before==='∗')&&latinNumber(visible[i-2]?.char);
   if(!visible.slice(i,end).some(item=>item.code)&&((han(before)&&latinNumber(after))||(han(after)&&(latinNumber(before)||latinSuffix)))){
    for(let n=i;n<end;n++)tokens[visible[n].index]='';
   }
   i=end;
  }
  return tokens.join('');
 }
 function html(value,options={}){
  let out=escape(value);
  out=out.replace(/S&lt;sub&gt;([NH])&lt;\/sub&gt;([12])/g,'S<sub>$1</sub>$2');
  // Protect a ligand's literal star before interpreting Markdown delimiters.
  // The numeric entity cannot be mistaken for an emphasis delimiter.
  out=out.replace(/\bL(?:\*|∗)(?=\d|[–—,，、。；;:：)）\s]|\*\*|$)/gu,'L<sup class="chem-ligand-star" style="font-size:0.75em;line-height:0;vertical-align:super">&#42;</sup>');
  out=out.replace(/\b(Cp|KTp|Tp)(?:\*|∗)(?=[A-Z\d]|[–—,，、。；;:：)）\]\s]|\*\*|$)/gu,'$1<sup class="chem-ligand-star" style="font-size:0.75em;line-height:0;vertical-align:super">&#42;</sup>');
  out=out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  out=out.replace(/\*\*([^\n]+?)\*\*/g,'<strong>$1</strong>');
  // Keep a figure/table label and its number together in justified Chinese prose.
  // Only presentation whitespace changes; ordinary chemical labels stay bold.
  out=out.replace(/(图式|图|表)[\t \u00a0\u3000]*<strong>(\d+[A-Za-z]?(?:[、，,–—-]\d+[A-Za-z]?)*)<\/strong>/g,
   '<span class="figure-reference" style="white-space:nowrap;word-spacing:normal;letter-spacing:normal">$1<strong class="figure-reference-number" style="font-family:inherit;font-size:inherit;line-height:inherit;font-weight:600;vertical-align:baseline">$2</strong></span>');
  out=out.replace(/(^|[^A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF])\*([^*\n]+)\*/g,'$1<em>$2</em>');
  out=out.replace(/`([^`]+)`/g,'<code>$1</code>');
  out=out.replace(/\n/g,'<br>');
  return options.preserveSpacing?out:compact(out);
 }
 const api={html,escape,compact};global.ReadInline=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
