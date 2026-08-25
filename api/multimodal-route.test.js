const test=require('node:test');
const assert=require('node:assert/strict');
const tools=require('./multimodal-route')._test;

test('selects a catchable live bus before a static fallback',()=>{
  const candidate=tools.usableBusCandidate({candidates:[{serviceNo:'A',catchableArrivalMinutes:null},{serviceNo:'B',catchableArrivalMinutes:5}]});
  assert.equal(candidate.serviceNo,'B');
});

test('composes bus to rail without pretending the partial path has a total ETA',()=>{
  const bus={transfers:0,totalWalkMetres:100,operator:'SBST',legs:[{serviceNo:'80',direction:1,boardStopCode:'1',alightStopCode:'2',rideStops:4,routeDistanceKm:2,liveStatus:'ready'}]};
  const rail={transfers:1,totalWalkMetres:50,legs:[{mode:'MRT',routeId:'NE'},{mode:'MRT',routeId:'CC'}]};
  const result=tools.composeBusRail(bus,rail,{id:'NE15',name:'Buangkok',lat:1.38,lng:103.89});
  assert.equal(result.kind,'bus-rail');
  assert.equal(result.rankable,false);
  assert.equal(result.timingStatus,'partial');
  assert.equal(result.transfers,2);
  assert.deepEqual(result.legs.map((leg)=>leg.mode),['BUS','MRT','MRT']);
});
