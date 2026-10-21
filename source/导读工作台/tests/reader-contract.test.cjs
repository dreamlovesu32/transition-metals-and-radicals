const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const contract = require('../reader-contract.js');
const cases = require('./fixtures/reading-contract.json').cases;
for (const item of cases) test('reading contract: ' + item.name, () => {
  const before = JSON.stringify(item);
  if (item.error) assert.throws(() => contract.compile(item.article, item.blocks));
  else assert.deepEqual(contract.compile(item.article, item.blocks), item.expected);
  assert.equal(JSON.stringify(item), before, 'compilation must not mutate science or manifest');
});

const core = fs.readFileSync(path.join(root, 'reader-core.js'), 'utf8');
function functions(from, to) {return core.slice(core.indexOf('function '+from+'('), core.indexOf('function '+to+'('));}
test('runtime is composed from entire shared files, without duplicate top-level functions or private transport', () => {
  const runtime = execFileSync('python', ['-c', 'from export_github_pages import public_reader_script;print(public_reader_script(),end="")'], {cwd:root,encoding:'utf8',env:{...process.env,PYTHONIOENCODING:'utf-8'}}).replace(/\r\n/g,'\n');
  for (const file of ['reader-contract.js','public-site/reader-prelude.js','reader-core.js','public-site/reader-boot.js']) {
    assert(runtime.includes(fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n').trim()), file);
  }
  const names = [...runtime.matchAll(/^(?:async )?function (\w+)\(/gm)].map(m=>m[1]);
  assert.equal(names.length, new Set(names).size);
  assert(!runtime.includes('/api/document'));
  assert(!runtime.includes('openEditor'));
  assert(!runtime.includes('workbench-reader.js'));
  assert(!fs.readFileSync(path.join(root,'public-site/read.html'),'utf8').includes('workbench-reader.js'));
  for (const file of ['app.js','public-site/reader-prelude.js']) {
    assert(!/^(?:async )?function (?:renderArticle|blockElement|showFigure|syncFigureToScroll)\(/m.test(fs.readFileSync(path.join(root,file),'utf8')));
  }
});

test('configured stable anchors, repeated assets and article-end use the same auto selector; pause remains authoritative', () => {
  const article={figures:[{file:'same.png'}],reading:{version:1,downThreshold:.6,upBuffer:.1,endBuffer:.3,switches:[{figureId:'f2',trigger:'block',anchorId:'p2'},{figureId:'f3',trigger:'article-end'}]}};
  const blocks=[{id:'t',kind:'title'},{id:'f1',kind:'figure',src:'figures/same.png'},{id:'p2',kind:'paragraph'},{id:'f2',kind:'figure',src:'figures/same.png'},{id:'f3',kind:'figure',src:'figures/same.png'}];
  const plan=contract.compile(article,blocks), picked=[];
  const positions={f1:-500,p2:400,f2:900,f3:1800};
  const nodes=Object.entries(positions).map(([id,top])=>({dataset:{blockId:id},getBoundingClientRect:()=>({top})}));
  const ctx={documentState:{article,readingPlan:plan},figureBlocks:blocks.filter(b=>b.kind==='figure'),currentFigureIndex:0,figureAuto:true,restoringReadingState:false,readingPrepared:true,readingPreparationSaved:null,
    window:{innerHeight:1000,scrollY:0},document:{scrollingElement:{scrollHeight:5000},documentElement:{scrollHeight:5000},querySelectorAll:()=>nodes,querySelector:()=>null},
    isDesktopLayout:()=>true,showFigure:index=>picked.push(index)};
  vm.createContext(ctx);vm.runInContext(functions('isReadingAtEnd','observeFigures'),ctx);
  ctx.syncFigureToScroll();assert.equal(picked.at(-1),1, 'p2 must trigger f2 before the inline f2 position');
  ctx.window.scrollY=4000;ctx.syncFigureToScroll();assert.equal(picked.at(-1),2, 'true document bottom selects final repeated image');
  ctx.figureAuto=false;const count=picked.length;ctx.syncFigureToScroll();assert.equal(picked.length,count,'manual pause must prevent document-end override');
});

test('configured upward and end buffers change geometry without changing global template code', () => {
  const ctx={};vm.createContext(ctx);vm.runInContext(functions('selectAutoFigure','resetAutoFigureTracking'),ctx);
  assert.equal(ctx.selectAutoFigure([-100,650],1,-1,520,1000,700,false,false,{upBuffer:.2}),1);
  assert.equal(ctx.selectAutoFigure([-100,650],1,-1,520,1000,700,false,false,{upBuffer:.1}),0);
  assert.equal(ctx.selectAutoFigure([-100,1800],1,1,520,1000,290,false,false,{endBuffer:.3}),1);
  assert.equal(ctx.selectAutoFigure([-100,1800],1,1,520,1000,310,false,false,{endBuffer:.3}),0);
});

test('local .html navigation keeps workbench export data source while published .html remains static', () => {
  const source=fs.readFileSync(path.join(root,'member-system/members.js'),'utf8');
  const definition=source.match(/  function locationIsStatic\([^\n]+/)[0];
  const ctx={location:{pathname:'/read.html'},document:{documentElement:{dataset:{readerSource:'workbench'}}}};
  vm.createContext(ctx);vm.runInContext(definition,ctx);
  assert.equal(ctx.locationIsStatic(),false);
  delete ctx.document.documentElement.dataset.readerSource;
  assert.equal(ctx.locationIsStatic(),true);
  ctx.location.pathname='/read';assert.equal(ctx.locationIsStatic(),false);
});
