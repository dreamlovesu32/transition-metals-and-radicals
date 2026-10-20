/* One escaped inline formatter for the reader, review text and material export. */
(function(global){
 'use strict';
 function escape(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
 function html(value){
  let out=escape(value);
  out=out.replace(/S&lt;sub&gt;([NH])&lt;\/sub&gt;([12])/g,'S<sub>$1</sub>$2');
  // Protect a ligand's literal star before interpreting Markdown delimiters.
  // The numeric entity cannot be mistaken for an emphasis delimiter.
  out=out.replace(/\bL(?:\*|∗)(?=\d|[–—,，、。；;:：)）\s]|\*\*|$)/gu,'L<sup class="chem-ligand-star" style="font-size:0.75em;line-height:0;vertical-align:super">&#42;</sup>');
  out=out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  out=out.replace(/\*\*([^\n]+?)\*\*/g,'<strong>$1</strong>');
  out=out.replace(/(^|[^A-Za-z0-9\u0370-\u03FF\u1F00-\u1FFF])\*([^*\n]+)\*/g,'$1<em>$2</em>');
  out=out.replace(/`([^`]+)`/g,'<code>$1</code>');
  return out.replace(/\n/g,'<br>');
 }
 const api={html,escape};global.ReadInline=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
