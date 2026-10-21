const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const file=process.env.READ_C02_SOURCE||path.join(__dirname,'../catalog.js'),source=fs.readFileSync(file,'utf8');
function harness(rows,mode='published'){
 const start=source.indexOf('function catalogSortValue(')>=0?source.indexOf('function catalogSortValue('):source.indexOf('function sortedArticles(');
 const ctx={catalogArticles:rows,$:()=>({value:mode}),Date};vm.createContext(ctx);vm.runInContext(source.slice(start,source.indexOf('function updateTrackControls(',start)),ctx);
 return kind=>Array.from(ctx.sortedArticles(kind),a=>a.id);
}
function permutations(xs){if(xs.length<2)return [xs];return xs.flatMap((x,i)=>permutations(xs.filter((_,j)=>j!==i)).map(rest=>[x,...rest]));}
const item=(id,date)=>({id,readingId:id,kind:'research',firstPublishedOn:date});

test('C02 exact publication days sort newest first regardless of live arrival order; unknown dates are last',()=>{
 const rows=[item('r20261018-01','2026-10-10'),item('r20261018-02','2026-10-09'),item('r20261018-03','2026-10-05'),item('unknown-a'),item('unknown-b')];
 for(const order of permutations(rows))assert.deepEqual(harness(order)('research'),['r20261018-01','r20261018-02','r20261018-03','unknown-b','unknown-a']);
});
test('C02 month-only, malformed and impossible dates cannot stand in for a verified first publication day',()=>{
 const rows=[item('month','2026-10'),item('display-month','2026.10'),item('impossible','2026-02-30'),item('time','2026-10-09T00:00:00Z'),item('valid','2026-10-05')];
 assert.equal(harness(rows)('research')[0],'valid');for(const row of rows.slice(0,-1))assert.equal(harness([row,rows.at(-1)])('research')[0],'valid');
});
test('C02 equal dates use a stable identity tie and never mutate source rows or mix article categories',()=>{
 const rows=[item('first','2026-10-05'),{...item('last','2026-10-05'),readingId:undefined},{...item('review','2026-10-10'),kind:'review'}],before=JSON.stringify(rows);
 assert.deepEqual(harness(rows)('research'),['last','first']);assert.deepEqual(harness(rows)('review'),['review']);assert.equal(JSON.stringify(rows),before);
});
test('C02 update ordering uses valid timestamps first, with invalid/missing timestamps stably last',()=>{
 const rows=[{...item('bad'),updatedAt:'bad'},{...item('later'),updatedAt:'2026-10-21T01:00:00Z'},{...item('older'),updatedAt:'2026-10-20T23:00:00+08:00'},item('missing')];
 for(const order of permutations(rows))assert.deepEqual(harness(order,'updated')('research'),['later','older','missing','bad']);
});
