const test=require('node:test');
const assert=require('node:assert/strict');
const train=require('./train-schedule')._shared;

function scheduleFixture(){
  const stops=new Map([
    ['A',{id:'A',name:'Alpha',lat:1.30,lng:103.80,parentStation:'',locationType:1}],
    ['B',{id:'B',name:'Bravo',lat:1.31,lng:103.81,parentStation:'',locationType:1}],
    ['C',{id:'C',name:'Central',lat:1.32,lng:103.82,parentStation:'',locationType:1}],
    ['D',{id:'D',name:'Delta',lat:1.33,lng:103.83,parentStation:'',locationType:1}],
  ]);
  const routes=new Map([
    ['R1',{id:'R1',shortName:'R1',longName:'',type:1}],
    ['R2',{id:'R2',shortName:'R2',longName:'',type:1}],
  ]);
  const trips=new Map([
    ['T1',{id:'T1',routeId:'R1',serviceId:'WK',directionId:0}],
    ['T2',{id:'T2',routeId:'R2',serviceId:'WK',directionId:0}],
  ]);
  const stopTimesByTrip=new Map([
    ['T1',[{stopId:'A',sequence:1,arrival:8*3600,departure:8*3600},{stopId:'B',sequence:2,arrival:8*3600+300,departure:8*3600+330},{stopId:'C',sequence:3,arrival:8*3600+600,departure:8*3600+630}]],
    ['T2',[{stopId:'C',sequence:1,arrival:8*3600+900,departure:8*3600+900},{stopId:'D',sequence:2,arrival:8*3600+1200,departure:8*3600+1200}]],
  ]);
  const calendars=new Map([['WK',{service_id:'WK',monday:'1',tuesday:'1',wednesday:'1',thursday:'1',friday:'1',saturday:'1',sunday:'1',start_date:'20260101',end_date:'20261231'}]]);
  return {stops,routes,trips,stopTimesByTrip,calendars,calendarDates:new Map(),graphCache:new Map(),stationCache:null};
}

test('parses quoted GTFS CSV fields',()=>{
  const rows=train.parseCsv('stop_id,stop_name\nA,"Alpha, Station"\n');
  assert.deepEqual(rows,[{stop_id:'A',stop_name:'Alpha, Station'}]);
});

test('routes across an MRT transfer using scheduled stop times',()=>{
  const schedule=scheduleFixture();
  const result=train.railJourney(schedule,{lat:1.30,lng:103.80},{lat:1.33,lng:103.83},{clock:{dateKey:'20260825',seconds:7*3600+55*60},railRadius:100});
  assert.ok(result);
  assert.equal(result.transfers,1);
  assert.deepEqual(result.legs.map((leg)=>leg.routeId),['R1','R2']);
  assert.equal(result.legs[0].boardStationId,'A');
  assert.equal(result.legs[1].alightStationId,'D');
  assert.equal(result.estimatedTotalMinutes,25);
});

test('does not route inactive service',()=>{
  const schedule=scheduleFixture();
  schedule.calendars.get('WK').tuesday='0';
  const result=train.railJourney(schedule,{lat:1.30,lng:103.80},{lat:1.33,lng:103.83},{clock:{dateKey:'20260825',seconds:7*3600+55*60},railRadius:100});
  assert.equal(result,null);
});
