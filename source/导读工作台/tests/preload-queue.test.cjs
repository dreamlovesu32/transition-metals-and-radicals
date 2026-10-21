const test=require('node:test'),assert=require('node:assert/strict');
const {create}=require('./preload-harness.cjs');
test('repeated calls during a batch yield cannot open a second background slot',async()=>{
 const h=create();h.ctx.preloadOtherFigures();await h.complete(h.requests[0].image);
 h.ctx.preloadOtherFigures();h.runTimer();assert.equal(h.requests.length,2);assert.equal(h.maxActive,1);h.ctx.preloadOtherFigures.cancel();
});
test('a hung detached download is aborted at timeout and errors do not retry forever or block following originals',async()=>{
 const h=create({count:8});h.ctx.preloadOtherFigures();const old=h.requests[0].image;
 h.runTimer(true);assert(h.cleared.includes(old));h.runTimer();assert.equal(h.requests[1].url,'figure-2');
 await h.complete(h.requests[1].image,true);h.runTimer();assert.equal(h.requests[2].url,'figure-3');await h.flush();
 assert.equal(h.requests.filter(x=>x.url==='figure-1').length,1);assert.equal(h.maxActive,1);
});
test('a decode completing after timeout cannot adopt a stale node or reopen the completed background slot',async()=>{
 const h=create({count:5});let release;h.ctx.decodeFigureImage=()=>new Promise(r=>release=r);
 h.ctx.preloadOtherFigures();const old=h.requests[0].image;await h.complete(old);h.runTimer(true);h.runTimer();
 const next=h.requests[1].image;release();await new Promise(setImmediate);
 assert(h.ctx.preloadOtherFigures.session.active);assert.equal(h.requests[1].image,next);assert.equal(h.requests.length,2);h.ctx.preloadOtherFigures.cancel();
});
test('review expiry and document replacement cancel the old generation and never resume private work',async()=>{
 const h=create({review:true});h.ctx.preloadOtherFigures();const old=h.requests[0].image;
 h.ctx.reviewIdentity.epoch=2;await h.complete(old);assert(h.ctx.preloadOtherFigures.session.cancelled);assert(!h.runTimer());assert.equal(h.requests.length,1);
 h.ctx.reviewMode=false;h.ctx.documentState={version_hash:'replacement'};h.ctx.preloadOtherFigures();const generation=h.ctx.preloadOtherFigures.session;
 await h.complete(old);assert.equal(h.ctx.preloadOtherFigures.session,generation);assert(generation.active);h.ctx.preloadOtherFigures.cancel();
});
test('cache trimming releases old panel ids but protects DOM and current high-priority request candidates',()=>{
 const h=create({count:2});const nodes=Array.from({length:50},()=>{const i=new h.Image();i.id='panel-figure-image';i.attrs.src='old';return i;});
 const connected=new h.Image();connected.isConnected=true;connected.attrs.src='inline';const pending=nodes[0];h.ctx.requestPanelFigure.pendingCandidate=pending;
 h.ctx.backgroundFigureImages.push(...nodes,connected);h.ctx.preloadOtherFigures();h.ctx.preloadOtherFigures.trim();
 assert(pending.getAttribute('src'));assert(connected.getAttribute('src'));assert(!h.cleared.includes(pending));assert(!h.cleared.includes(connected));assert(h.ctx.backgroundFigureImages.filter(i=>!i.isConnected&&i!==pending).length<=6);h.ctx.preloadOtherFigures.cancel();
});
test('single-column current original keeps high priority while adjacent originals stay background work',()=>{
 const h=create();h.ctx.isDesktopLayout=()=>false;h.ctx.currentFigureIndex=12;h.ctx.preloadOtherFigures();
 assert.equal(h.requests[0].url,'figure-12');assert.equal(h.requests[0].image.fetchPriority,'high');h.ctx.preloadOtherFigures.cancel();
});
test('a near inline original adopts the downloaded decoded node before scrolling, and cache trimming never blanks it',async()=>{
 const wraps=[],h=create({count:4,wraps});let inline=new h.Image();inline.dataset.src='figure-1';inline.isConnected=true;
 inline.replaceWith=image=>{inline.isConnected=false;inline=image;image.isConnected=true;};
 wraps.push({dataset:{blockId:'f1'},querySelector:()=>inline});
 h.ctx.preloadOtherFigures();const downloaded=h.requests[0].image;await h.complete(downloaded);await new Promise(setImmediate);
 assert.equal(inline,downloaded);assert.equal(inline.getAttribute('src'),'figure-1');assert.equal(inline.dataset.decoded,'true');assert(inline.revealed);assert.equal(h.requests.filter(x=>x.url==='figure-1').length,1);
 h.ctx.preloadOtherFigures.trim();assert(!h.cleared.includes(inline));h.ctx.preloadOtherFigures.cancel();assert(inline.getAttribute('src'),'a connected adopted original must survive cancellation until the reader clears its document');
});
