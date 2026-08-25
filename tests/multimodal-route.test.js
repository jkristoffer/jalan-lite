const test=require('node:test');
const assert=require('node:assert/strict');
const tools=require('../api/multimodal-route')._test;

test('selects a catchable live bus before a static fallback',()=>{
  const candidate=tools.usableBusCandidate({candidates:[{serviceNo:'A',catchableArrivalMinutes:null},{serviceNo:'B',catchableArrivalMinutes:5}]});
  assert.equal(candidate.serviceNo,'B');
});

test('keeps transfer bus connectors out of the timed direct-bus pool',()=>{
  const candidates=tools.directLiveBusCandidates({candidates:[
    {kind:'transfer',transfers:1,catchableArrivalMinutes:2,legs:[{},{}]},
    {kind:'direct',transfers:0,catchableArrivalMinutes:4,legs:[{routeDistanceKm:1.5,rideStops:4}]},
  ]});
  assert.equal(candidates.length,1);
  assert.equal(candidates[0].kind,'direct');
});

test('accepts a short direct bus timing estimate but rejects a long uncertain one',()=>{
  const short=tools.estimateDirectBusTiming({transfers:0,catchableArrivalMinutes:4,alight:{distanceMetres:46},legs:[{routeDistanceKm:1.5,rideStops:4}]});
  assert.equal(short.reliable,true);
  assert.ok(short.estimatedRideMinutes>5 && short.estimatedRideMinutes<6);
  const long=tools.estimateDirectBusTiming({transfers:0,catchableArrivalMinutes:2,alight:{distanceMetres:90},legs:[{routeDistanceKm:17.7,rideStops:44}]});
  assert.equal(long.reliable,false);
  assert.ok(long.spreadMinutes>40);
});

test('advances the rail search clock by the bus connector estimate',()=>{
  assert.deepEqual(tools.advanceClock({dateKey:'20260825',seconds:36000},5.2),{dateKey:'20260825',seconds:36312});
});

test('composes bus to rail without pretending an uncertain path has a total ETA',()=>{
  const bus={transfers:0,totalWalkMetres:100,operator:'SBST',legs:[{serviceNo:'80',direction:1,boardStopCode:'1',alightStopCode:'2',rideStops:4,routeDistanceKm:2,liveStatus:'ready'}]};
  const rail={transfers:1,totalWalkMetres:50,legs:[{mode:'MRT',routeId:'NE'},{mode:'MRT',routeId:'CC'}]};
  const result=tools.composeBusRail(bus,rail,{id:'NE15',name:'Buangkok',lat:1.38,lng:103.89});
  assert.equal(result.kind,'bus-rail');
  assert.equal(result.rankable,false);
  assert.equal(result.timingStatus,'partial');
  assert.equal(result.transfers,2);
});

test('composes a bounded direct bus to rail estimate as rankable',()=>{
  const bus={transfers:0,totalWalkMetres:189,catchableArrivalMinutes:4,operator:'SBST',legs:[{serviceNo:'163',direction:2,boardStopCode:'65021',alightStopCode:'67009',rideStops:4,routeDistanceKm:1.5,liveStatus:'ready'}]};
  const timing=tools.estimateDirectBusTiming({...bus,alight:{distanceMetres:46}});
  const rail={transfers:1,totalWalkMetres:90,estimatedTotalMinutes:23,legs:[{mode:'MRT',routeId:'NEL'},{mode:'MRT',routeId:'CCL_LOOP'}]};
  const result=tools.composeEstimatedBusRail(bus,rail,{id:'NE16',name:'Sengkang',lat:1.39,lng:103.89},timing,{minTotalMinutes:31,maxTotalMinutes:36});
  assert.equal(result.timingStatus,'estimated');
  assert.equal(result.rankable,true);
  assert.ok(result.estimatedTotalMinutes>=33 && result.estimatedTotalMinutes<=34);
  assert.equal(result.legs[0].timingConfidence,'estimated');
});

test('prefers MRT connector options before LRT when distances are otherwise comparable',()=>{
  const sorted=tools.sortConnectorOptions([
    {station:{id:'SE4',distanceMetres:700},rail:{legs:[{mode:'LRT'}]}},
    {station:{id:'NE16',distanceMetres:900},rail:{legs:[{mode:'MRT'}]}},
  ]);
  assert.equal(sorted[0].station.id,'NE16');
});

test('re-runs rail timing after the estimated bus arrival at the connector',()=>{
  const bus={kind:'direct',transfers:0,totalWalkMetres:189,catchableArrivalMinutes:4,operator:'SBST',alight:{distanceMetres:46},legs:[{serviceNo:'163',direction:2,boardStopCode:'65021',alightStopCode:'67009',rideStops:4,routeDistanceKm:1.5,liveStatus:'ready'}]};
  const originalRailJourney = require('../train-schedule-source').railJourney;
  require('../train-schedule-source').railJourney = (_schedule,_start,_end,{clock}) => ({transfers:0,totalWalkMetres:50,estimatedTotalMinutes:clock.seconds % 600 === 0 ? 20 : 21,legs:[{mode:'MRT',routeId:'NEL'}]});
  try {
    const result=tools.timedBusRailCandidate({}, {lat:1.33,lng:103.88}, {dateKey:'20260825',seconds:36000}, {id:'NE16',name:'Sengkang',lat:1.39,lng:103.89}, bus);
    assert.equal(result.kind,'bus-rail');
    assert.equal(result.timingStatus,'estimated');
    assert.equal(result.rankable,true);
    assert.ok(result.estimatedTotalMinutes>29);
  } finally {
    require('../train-schedule-source').railJourney = originalRailJourney;
  }
});
