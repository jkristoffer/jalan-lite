const test=require('node:test');
const assert=require('node:assert/strict');
const tools=require('./multimodal-route')._test;

test('selects a catchable live bus before a static fallback',()=>{
  const candidate=tools.usableBusCandidate({candidates:[{serviceNo:'A',catchableArrivalMinutes:null},{serviceNo:'B',catchableArrivalMinutes:5}]});
  assert.equal(candidate.serviceNo,'B');
});

test('estimates a short direct monitored connector conservatively',()=>{
  const candidate={kind:'direct',transfers:0,catchableArrivalMinutes:4,arrivals:[4,20,27],monitored:[true,true,true],alight:{distanceMetres:46},legs:[{routeDistanceKm:1.5,rideStops:4}]};
  assert.deepEqual(tools.estimateDirectBusToStation(candidate),{confidence:'bounded-estimate',busWaitMinutes:4,busRideMinutes:5,stationWalkMinutes:1,stationEntryBufferMinutes:2,toStationMinutes:12});
});

test('rejects long, transferred, or unmonitored bus connectors',()=>{
  const base={kind:'direct',transfers:0,catchableArrivalMinutes:4,arrivals:[4],monitored:[true],alight:{distanceMetres:20},legs:[{routeDistanceKm:2,rideStops:5}]};
  assert.equal(tools.estimateDirectBusToStation({...base,legs:[{routeDistanceKm:9,rideStops:5}]}),null);
  assert.equal(tools.estimateDirectBusToStation({...base,kind:'transfer',transfers:1,legs:[{routeDistanceKm:2,rideStops:5},{routeDistanceKm:1,rideStops:2}]}),null);
  assert.equal(tools.estimateDirectBusToStation({...base,monitored:[false]}),null);
});

test('shifts the rail search clock by the bounded bus connector time',()=>{
  assert.deepEqual(tools.shiftedClock({dateKey:'20260825',seconds:50000},12),{dateKey:'20260825',seconds:50720});
});

test('composes a bounded bus to rail path with an estimated total time',()=>{
  const bus={kind:'direct',transfers:0,totalWalkMetres:100,catchableArrivalMinutes:4,operator:'SBST',legs:[{serviceNo:'163',direction:2,boardStopCode:'1',alightStopCode:'2',rideStops:4,routeDistanceKm:1.5,liveStatus:'ready'}]};
  const rail={transfers:1,totalWalkMetres:50,estimatedTotalMinutes:20,legs:[{mode:'MRT',routeId:'NE'},{mode:'MRT',routeId:'CC'}]};
  const estimate={confidence:'bounded-estimate',busWaitMinutes:4,busRideMinutes:5,stationWalkMinutes:1,stationEntryBufferMinutes:2,toStationMinutes:12};
  const result=tools.composeBusRail(bus,rail,{id:'NE16',name:'Sengkang',lat:1.39,lng:103.89},estimate);
  assert.equal(result.rankable,true);
  assert.equal(result.timingStatus,'estimated');
  assert.equal(result.estimatedTotalMinutes,32);
});

test('keeps an unbounded bus to rail path partial and unranked',()=>{
  const bus={transfers:0,totalWalkMetres:100,operator:'SBST',legs:[{serviceNo:'80',direction:1,boardStopCode:'1',alightStopCode:'2',rideStops:24,routeDistanceKm:10,liveStatus:'ready'}]};
  const rail={transfers:1,totalWalkMetres:50,estimatedTotalMinutes:20,legs:[{mode:'MRT',routeId:'NE'},{mode:'MRT',routeId:'CC'}]};
  const result=tools.composeBusRail(bus,rail,{id:'NE15',name:'Buangkok',lat:1.38,lng:103.89});
  assert.equal(result.rankable,false);
  assert.equal(result.timingStatus,'partial');
  assert.equal(result.estimatedTotalMinutes,undefined);
});
