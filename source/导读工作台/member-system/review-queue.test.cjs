const test=require('node:test'),assert=require('node:assert/strict');
const {reviewBucket}=require('./members.js');
test('review queue distinguishes publication from exact-version approval',()=>{
 assert.equal(reviewBucket({published:true,review_status:'pending'}),'pending');
 assert.equal(reviewBucket({published:true,review_status:'proofreading'}),'proofreading');
 assert.equal(reviewBucket({published:true,review_status:'approved'}),'completed');
 assert.equal(reviewBucket({published:false,review_status:'approved'}),'completed');
 assert.equal(reviewBucket({review_status:'changes_requested'}),'pending');
 assert.equal(reviewBucket({}),'pending');
});
