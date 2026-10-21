const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const tool=require('../member-system/article-export.js');
const root=path.resolve(__dirname,'..'),formatter=require('../inline-format.js');
const sup='<sup class="chem-ligand-star" style="font-size:0.75em;line-height:0;vertical-align:super">&#42;</sup>';
function reader(file){const s=fs.readFileSync(path.join(root,file),'utf8');const a=s.indexOf('function escapeHtml('),b=s.indexOf('\nfunction ',s.indexOf('function inlineMarkdown(',a)+1);const ctx=vm.createContext({window:{ReadInline:formatter}});vm.runInContext(s.slice(a,b),ctx);return text=>ctx.inlineMarkdown(text);}
const local=reader('reader-core.js'),publicReader=reader('reader-core.js');
const canonical=html=>html.replace(/\sstyle="[^"]*"/g,'');
const hasFormatted=(html,expected)=>canonical(html).includes(canonical(expected));
const ref=(kind,number)=>`<span class="figure-reference" style="white-space:nowrap;word-spacing:normal;letter-spacing:normal">${kind}<strong class="figure-reference-number" style="font-family:inherit;font-size:inherit;line-height:inherit;font-weight:600;vertical-align:baseline">${number}</strong></span>`;
const text='配体 L* 与 L∗，Cu/L* 仍为配体。图 **2A** 与图式 **3**；S<sub>N</sub>2 和 S<sub>H</sub>2。*斜体* **粗体**';
const expected='配体L'+sup+'与L'+sup+'，Cu/L'+sup+'仍为配体。'+ref('图','2A')+'与'+ref('图式','3')+'；S<sub>N</sub>2和S<sub>H</sub>2。<em>斜体</em> <strong>粗体</strong>';
test('local, public, downloaded export preserve ligand stars and exact formatting ranges',()=>{assert.equal(local(text),expected);assert.equal(publicReader(text),expected);const html=tool.render([{kind:'paragraph',text}],new Map());assert.ok(hasFormatted(html,'>'+expected+'</p>'));assert.equal((html.match(/<strong\b/g)||[]).length,3);assert.ok(!html.includes('<strong>图'));});
test('review full/day exports share renderer and justified downloadable/clipboard body',()=>{const blocks=[{id:'p',kind:'paragraph',text},{id:'h',kind:'heading',text:'下一节'},{id:'p2',kind:'paragraph',text}];const full=tool.render(blocks,new Map()),parts=tool.split(blocks,['h']);for(const part of parts){const html=tool.render(part.blocks,new Map());assert.ok(hasFormatted(html,expected));for(const tag of html.matchAll(/<(?:p|h[234]) style="([^"]+)"/g))assert.ok(tag[1].includes('text-align:justify'));const doc=tool.documentHtml('标题',html);assert.ok(doc.includes('<article id="export-body">'+html+'</article>'));assert.ok(doc.includes('copyPayload'));assert.ok(doc.includes('text/html'));}assert.ok(hasFormatted(full,expected));});

test('ASCII chemical stars inside bold ligand labels never break markup across prose',()=>{const text='使用 **L*6** 配体和 **L*1**，图 **2A** 保留编号。';const expected='使用<strong>L'+sup+'6</strong>配体和<strong>L'+sup+'1</strong>，'+ref('图','2A')+'保留编号。';assert.equal(local(text),expected);assert.equal(publicReader(text),expected);assert.ok(hasFormatted(tool.render([{kind:'paragraph',text}],new Map()),'>'+expected+'</p>'));});
test('member draft inline rendering uses the shared superscript formatter',()=>{const s=fs.readFileSync(path.join(root,'member-system/members.js'),'utf8');const ctx=vm.createContext({global:{ReadInline:formatter},el:()=>({innerHTML:''})});vm.runInContext(s.slice(s.indexOf('  function inlineNodes('),s.indexOf('\n  ',s.indexOf('  function inlineNodes(')+3)),ctx);const text='用 **L*6** 与 L*，再用 L*。图 **2A**';assert.equal(ctx.inlineNodes(text).innerHTML,formatter.html(text));assert.equal((ctx.inlineNodes(text).innerHTML.match(/<sup /g)||[]).length,3);});


test('figure references remove only label gaps and retain baseline inline emphasis in every renderer',()=>{
 const source='参见图 **2A**、表\u3000**1**和图式**1C、1D**；化合物 **2A** 与 **L*6**，正文 **粗体**。';
 const expected='参见'+ref('图','2A')+'、'+ref('表','1')+'和'+ref('图式','1C、1D')+'；化合物<strong>2A</strong>与<strong>L'+sup+'6</strong>，正文 <strong>粗体</strong>。';
 for(const render of [formatter.html,local,publicReader])assert.equal(render(source),expected);
 const exported=tool.render([{kind:'paragraph',text:source}],new Map());
 assert.ok(hasFormatted(exported,expected));
 assert.ok(!exported.includes('inline-block'));
 assert.ok(!exported.includes('translate'));
 assert.equal(source,'参见图 **2A**、表\u3000**1**和图式**1C、1D**；化合物 **2A** 与 **L*6**，正文 **粗体**。');
});


test('Chinese joins numbers and English across strong/em while number-unit and English-word spaces survive',()=>{
 const cases=[
  ['产物 **1** 和底物 *2A* 反应','产物<strong>1</strong>和底物<em>2A</em>反应'],
  ['采用 TEMPO 以及 **DFT** 计算，研究 *radical pathway* 过程','采用TEMPO以及<strong>DFT</strong>计算，研究<em>radical pathway</em>过程'],
  ['在 25 °C 下用 10 mol% 催化剂、5 mL 溶剂，能垒为 20 kcal·mol⁻¹','在25 °C下用10 mol%催化剂、5 mL溶剂，能垒为20 kcal·mol⁻¹'],
  ['在 **25** *°C* 下用 **10** **mol%** 催化剂、**5** *mL* 溶剂','在<strong>25</strong> <em>°C</em>下用<strong>10</strong> <strong>mol%</strong>催化剂、<strong>5</strong> <em>mL</em>溶剂'],
  ['能垒为 **20** *kcal·mol⁻¹*，higher selectivity 保留英文词间空格','能垒为<strong>20</strong> <em>kcal·mol⁻¹</em>，higher selectivity保留英文词间空格'],
  ['产物\u00a0**1**\u3000再经 TEMPO\t捕获','产物<strong>1</strong>再经TEMPO捕获'],
  ['正文\n1 new line\n中文','正文<br>1 new line<br>中文'],
  ['代码 `中文 1 new word` 内部不改','代码 <code>中文 1 new word</code>内部不改']
 ];
 for(const [source,expected]of cases){
  for(const render of [formatter.html,local,publicReader])assert.equal(render(source),expected,source);
  const blocks=[{id:'p',kind:'paragraph',text:source},{id:'h',kind:'heading',text:'第二节'},{id:'q',kind:'quote',text:source}];
  const frozen=JSON.stringify(blocks),html=tool.render(blocks,new Map());assert(hasFormatted(html,'>'+expected+'</p>'));assert(hasFormatted(html,'>'+expected+'</blockquote>'));assert.equal(JSON.stringify(blocks),frozen);
  const parts=tool.split(blocks,['h']);for(const part of parts)assert(hasFormatted(tool.render(part.blocks,new Map()),expected));
 }
});

test('spacing normalization never changes link URL attributes or HTML escaping and all exported blocks disable autospace',()=>{
 const source='查看 [DFT data](https://example.org/中文%201?name=a&value=b) 结果，产物 **1**。';
 const html=formatter.html(source);assert(html.includes('href="https://example.org/中文%201?name=a&amp;value=b"'));assert(html.includes('>DFT data</a>结果'));assert(html.includes('产物<strong>1</strong>'));
 assert(!formatter.html('中文 <script>alert(1)</script> 结果').includes('<script>'));
 const body=tool.render([{kind:'paragraph',text:source},{kind:'heading',text:source},{kind:'bullet',text:source},{kind:'quote',text:source},{kind:'figure',src:'x',text:source}],new Map([['x','images/original.png']]));
 for(const tag of body.matchAll(/<(?:p|h[234]|ul|blockquote|section) style="([^"]+)"/g))assert(tag[1].includes('text-autospace:no-autospace'));
 const doc=tool.documentHtml('title',body);assert(doc.includes('text-autospace:no-autospace'));assert(doc.includes('copyPayload'));
 const css=fs.readFileSync(path.join(root,'app.css'),'utf8');assert(css.includes('html[lang="zh-CN"] #article,html[lang="zh-CN"] .figure-panel-meta{text-autospace:no-autospace}'));
});
