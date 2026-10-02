const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('./route-shell.js'), 'utf8');
function extract(name) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.slice(start + 3).search(/\n  (?:async )?function /);
  return source.slice(start, start + 3 + end);
}
function context(names, values = {}) {
  const scope = vm.createContext(values);
  vm.runInContext(names.map(extract).join('\n'), scope);
  return scope;
}
const now = Date.parse('2026-10-02T06:00:00Z');
const leg = {routeName:'NS',fromId:'NS16',toId:'NS17'};
const stop = (id, order, minutes) => ({stopId:id,stopSequence:order,departureTime:now+minutes*60000,arrivalTime:now+minutes*60000});
const matcher = () => context(['toTimestamp','trainLineKey','sameStop','trainMatch'], {trainAlertMatches:()=>false});
test('train matching cannot borrow times from different stations or reverse direction', () => {
  const c = matcher();
  for (const stops of [[stop('NS1',1,5),stop('NS2',2,10)],[stop('NS17',1,5),stop('NS16',2,10)],[stop('NS16',1,-5),stop('NS17',2,1)]]) {
    assert.equal(c.trainMatch(leg,{updates:[{routeId:'NSL',stops}]},now),null);
  }
});
test('train matching selects a future trip with both stations in order', () => {
  const c=matcher();
  const result=c.trainMatch(leg,{updates:[{routeId:'NSL',stops:[stop('NS16',1,5),stop('NS17',2,10)]}]},now);
  assert.equal(result.departureTime,now+300000);
  assert.equal(result.arrivalTime,now+600000);
});
test('saving recurrence keeps the dated preview timetable and active session plan consistent', () => {
  let persisted;
  const preview={id:'a',date:'2026-10-02',timeMode:'now',departureTime:'14:00',origin:'A',destination:'B',originPoint:{lat:1,lng:103},destinationPoint:{lat:2,lng:104}};
  const c=context(['save'],{saved:preview,activeSession:{phase:'waiting'},routineStorage:{load:()=>({routines:[]}),routineFromRoute:value=>({id:'route:a',...value}),save:items=>{persisted=items;return{ok:true}}},journeyTools:{save:()=>({ok:true})},draft:v=>v});
  assert.equal(c.save({...preview,date:'2026-10-03',departureTime:'18:00',timeMode:'arrive',name:'Evening'}),true);
  assert.equal(persisted[0].departureTime,'18:00');
  assert.equal(c.saved.departureTime,'14:00');
  assert.equal(c.saved.date,'2026-10-02');
  assert.equal(c.activeSession.plan.date,'2026-10-02');
});
test('failed routine saving keeps current plan and draft', () => {
  const plan={id:'a'},draft={name:'Unsaved'};
  const c=context(['save'],{saved:plan,draftState:draft,routineStorage:{load:()=>({routines:[]}),routineFromRoute:()=>({id:'route:a'}),save:()=>({ok:false})}});
  assert.equal(c.save({id:'a',name:'New'}),false);
  assert.equal(c.saved,plan);assert.equal(c.draftState,draft);assert.match(c.formError,/Could not save/);
});
test('completed occurrence is excluded when reopening the app in the same tab', () => {
  const schedule=require('./routine-schedule');
  const routine={id:'route:a',type:'route',schedule:{departureTime:'14:00',timeMode:'depart',days:null}};
  const clock={now:()=>now+20*60000};
  const c=context(['occurrenceFor'],{completedOccurrences:['route:a:2026-10-02'],Date:clock,window:{JalanSchedule:{...schedule,nextOccurrence:(r,n=clock.now(),o)=>schedule.nextOccurrence(r,n,o)}}});
  assert.equal(c.occurrenceFor(routine).date,'2026-10-03');
});
