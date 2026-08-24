const { inflateRawSync } = require('node:zlib');

const TRIP_UPDATES_URL = 'https://datamall.lta.gov.sg/content/dam/datamall/datasets/PublicTransportRelated/GTFSRealtimeTrainTripUpdates.zip';
const SERVICE_ALERTS_URL = 'https://datamall.lta.gov.sg/content/dam/datamall/datasets/PublicTransportRelated/GTFSRealTimeTrainServiceAlerts.zip';

const textDecoder = new TextDecoder();

function uint32(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function uint16(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function findSignature(bytes, signature, start = 0) {
  for (let index = start; index <= bytes.length - 4; index += 1) {
    if (uint32(bytes, index) === signature) return index;
  }
  return -1;
}

function unzipFirst(bytes) {
  if (uint32(bytes, 0) !== 0x04034b50) return bytes;

  let cursor = 0;
  while (cursor <= bytes.length - 30) {
    if (uint32(bytes, cursor) !== 0x04034b50) break;
    const flags = uint16(bytes, cursor + 6);
    const method = uint16(bytes, cursor + 8);
    let compressedSize = uint32(bytes, cursor + 18);
    const nameLength = uint16(bytes, cursor + 26);
    const extraLength = uint16(bytes, cursor + 28);
    const name = textDecoder.decode(bytes.slice(cursor + 30, cursor + 30 + nameLength));
    const dataStart = cursor + 30 + nameLength + extraLength;

    if ((flags & 0x08) && !compressedSize) {
      const central = findSignature(bytes, 0x02014b50, dataStart);
      if (central >= 0) compressedSize = uint32(bytes, central + 20);
    }

    const isFeedEntry = /\.(?:pb|bin)(?:\.gz)?$/i.test(name) || /trip.*update|service.*alert/i.test(name);
    if (!name.endsWith('/') && isFeedEntry && compressedSize >= 0 && dataStart + compressedSize <= bytes.length) {
      const payload = bytes.slice(dataStart, dataStart + compressedSize);
      if (method === 0) return payload;
      if (method === 8) return new Uint8Array(inflateRawSync(payload));
    }

    const nextEntry = dataStart + compressedSize;
    if (nextEntry > cursor && nextEntry <= bytes.length) cursor = nextEntry;
    else {
      const nextHeader = findSignature(bytes, 0x04034b50, dataStart);
      if (nextHeader < 0) break;
      cursor = nextHeader;
    }
  }

  throw new Error('Unable to read the LTA GTFS-Realtime ZIP feed.');
}

function readVarint(bytes, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < bytes.length) {
    const byte = bytes[cursor];
    cursor += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return { value, offset: cursor };
    shift += 7n;
    if (shift > 70n) throw new Error('Invalid protobuf varint.');
  }
  throw new Error('Unexpected end of protobuf message.');
}

function signed(value, bits = 32) {
  const limit = 1n << BigInt(bits);
  return Number(value >= limit / 2n ? value - limit : value);
}

function fieldsOf(bytes) {
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const number = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);
    if (!number) throw new Error('Invalid protobuf field number.');

    if (wire === 0) {
      const value = readVarint(bytes, offset);
      fields.push({ number, wire, value: value.value });
      offset = value.offset;
    } else if (wire === 1) {
      fields.push({ number, wire, value: bytes.slice(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      const end = offset + Number(length.value);
      if (end > bytes.length) throw new Error('Invalid protobuf message length.');
      fields.push({ number, wire, value: bytes.slice(offset, end) });
      offset = end;
    } else if (wire === 5) {
      fields.push({ number, wire, value: bytes.slice(offset, offset + 4) });
      offset += 4;
    } else if (wire === 4) {
      break;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}.`);
    }
  }
  return fields;
}

function first(fields, number, wire) {
  return fields.find((field) => field.number === number && (wire === undefined || field.wire === wire));
}

function all(fields, number, wire) {
  return fields.filter((field) => field.number === number && (wire === undefined || field.wire === wire));
}

function stringValue(field) {
  return field?.wire === 2 ? textDecoder.decode(field.value) : '';
}

function numberValue(field) {
  return field?.wire === 0 ? Number(field.value) : 0;
}

function messageValue(field) {
  return field?.wire === 2 ? field.value : null;
}

function parseTimeEvent(bytes) {
  if (!bytes) return null;
  const fields = fieldsOf(bytes);
  const time = first(fields, 2, 0);
  const delay = first(fields, 1, 0);
  return {
    time: time ? Number(time.value) * 1000 : 0,
    delay: delay ? signed(delay.value) : 0,
  };
}

function parseTripDescriptor(bytes) {
  if (!bytes) return {};
  const fields = fieldsOf(bytes);
  return {
    tripId: stringValue(first(fields, 1, 2)),
    startTime: stringValue(first(fields, 2, 2)),
    startDate: stringValue(first(fields, 3, 2)),
    scheduleRelationship: numberValue(first(fields, 4, 0)),
    routeId: stringValue(first(fields, 5, 2)),
    directionId: numberValue(first(fields, 6, 0)),
  };
}

function parseStopTimeUpdate(bytes) {
  const fields = fieldsOf(bytes);
  const arrival = parseTimeEvent(messageValue(first(fields, 2, 2)));
  const departure = parseTimeEvent(messageValue(first(fields, 3, 2)));
  return {
    stopSequence: numberValue(first(fields, 1, 0)),
    stopId: stringValue(first(fields, 4, 2)),
    scheduleRelationship: numberValue(first(fields, 5, 0)),
    arrivalTime: arrival?.time || 0,
    departureTime: departure?.time || 0,
    arrivalDelay: arrival?.delay || 0,
    departureDelay: departure?.delay || 0,
  };
}

function parseTripUpdate(bytes) {
  if (!bytes) return {};
  const fields = fieldsOf(bytes);
  const trip = parseTripDescriptor(messageValue(first(fields, 1, 2)));
  return {
    ...trip,
    timestamp: first(fields, 4, 0) ? Number(first(fields, 4, 0).value) * 1000 : 0,
    delay: first(fields, 5, 0) ? signed(first(fields, 5, 0).value) : 0,
    stops: all(fields, 3, 2).map((field) => parseStopTimeUpdate(field.value)),
  };
}

function parseTranslation(bytes) {
  if (!bytes) return '';
  const fields = fieldsOf(bytes);
  const translation = messageValue(first(fields, 1, 2));
  return translation ? stringValue(first(fieldsOf(translation), 1, 2)) : '';
}

function parseAlert(bytes) {
  if (!bytes) return {};
  const fields = fieldsOf(bytes);
  const selectors = all(fields, 5, 2).map((field) => {
    const selector = fieldsOf(field.value);
    return { routeId: stringValue(first(selector, 2, 2)), stopId: stringValue(first(selector, 3, 2)) };
  });
  const activePeriod = messageValue(first(fields, 1, 2));
  const activeFields = activePeriod ? fieldsOf(activePeriod) : [];
  return {
    selectors,
    cause: numberValue(first(fields, 6, 0)),
    effect: numberValue(first(fields, 7, 0)),
    header: parseTranslation(messageValue(first(fields, 10, 2))),
    description: parseTranslation(messageValue(first(fields, 11, 2))),
    startTime: first(activeFields, 1, 0) ? Number(first(activeFields, 1, 0).value) * 1000 : 0,
    endTime: first(activeFields, 2, 0) ? Number(first(activeFields, 2, 0).value) * 1000 : 0,
  };
}

function parseFeed(bytes, kind) {
  const fields = fieldsOf(bytes);
  const header = messageValue(first(fields, 1, 2));
  const headerFields = header ? fieldsOf(header) : [];
  const timestamp = first(headerFields, 3, 0) ? Number(first(headerFields, 3, 0).value) * 1000 : 0;
  const entities = all(fields, 2, 2).map((field) => {
    const entityFields = fieldsOf(field.value);
    return {
      id: stringValue(first(entityFields, 1, 2)),
      deleted: Boolean(numberValue(first(entityFields, 2, 0))),
      tripUpdate: kind === 'trips' ? parseTripUpdate(messageValue(first(entityFields, 3, 2))) : null,
      alert: kind === 'alerts' ? parseAlert(messageValue(first(entityFields, 5, 2))) : null,
    };
  });
  return { timestamp, entities };
}

function canonicalLine(value) {
  const token = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const aliases = {
    NSL: ['NSL', 'NS', 'NORTHSOUTH', 'NORTHSOUTHLINE'],
    EWL: ['EWL', 'EW', 'EASTWEST', 'EASTWESTLINE'],
    NEL: ['NEL', 'NE', 'NORTHEAST', 'NORTHEASTLINE'],
    CCL: ['CCL', 'CC', 'CIRCLE', 'CIRCLELINE'],
    DTL: ['DTL', 'DT', 'DOWNTOWN', 'DOWNTOWNLINE'],
    TEL: ['TEL', 'TE', 'THOMSONEASTCOAST', 'THOMSONEASTCOASTLINE'],
    BPL: ['BPL', 'BP', 'BUKITPANJANG', 'BUKITPANJANGLRT'],
    SGL: ['SGL', 'SE', 'SENGKANG', 'SENGKANGLRT'],
    PGL: ['PGL', 'PE', 'PUNGGOL', 'PUNGGOLLRT'],
  };
  return Object.entries(aliases).find(([, values]) => values.some((alias) => token === alias || token.includes(alias)))?.[0] || token;
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function queryMatch(update, routes, stops) {
  const routeMatch = !routes.length || routes.some((route) => canonicalLine(route) === canonicalLine(update.routeId));
  const stopMatch = !stops.length || update.stops.some((stop) => stops.some((requested) => requested === stop.stopId || requested.endsWith(stop.stopId) || stop.stopId.endsWith(requested)));
  return routeMatch || stopMatch;
}

function alertMatch(alert, routes, stops) {
  if (!routes.length && !stops.length) return true;
  return alert.selectors.some((selector) => routes.some((route) => selector.routeId && canonicalLine(route) === canonicalLine(selector.routeId)) || stops.some((stop) => selector.stopId && (stop === selector.stopId || stop.endsWith(selector.stopId) || selector.stopId.endsWith(stop))));
}

async function fetchFeed(url, apiKey) {
  const response = await fetch(url, { headers: { AccountKey: apiKey, Accept: 'application/zip, application/octet-stream' } });
  if (!response.ok) throw new Error(`LTA GTFS-Realtime request failed (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=15');
  try {
    const apiKey = process.env.LTA_API_KEY;
    if (!apiKey) return res.status(503).json({ error: 'LTA_API_KEY is not configured.' });
    const requestUrl = new URL(req.url, 'https://jalan.local');
    const routes = csv(requestUrl.searchParams.get('routes'));
    const stops = csv(requestUrl.searchParams.get('stops'));
    const [tripResult, alertResult] = await Promise.all([
      fetchFeed(TRIP_UPDATES_URL, apiKey).then((bytes) => parseFeed(unzipFirst(bytes), 'trips')),
      fetchFeed(SERVICE_ALERTS_URL, apiKey).then((bytes) => parseFeed(unzipFirst(bytes), 'alerts')).catch(() => ({ timestamp: 0, entities: [] })),
    ]);
    const updates = tripResult.entities.filter((entity) => entity.tripUpdate && !entity.deleted && queryMatch(entity.tripUpdate, routes, stops)).map((entity) => ({ id: entity.id, ...entity.tripUpdate }));
    const alerts = alertResult.entities.filter((entity) => entity.alert && !entity.deleted && alertMatch(entity.alert, routes, stops)).map((entity) => ({ id: entity.id, ...entity.alert }));
    return res.status(200).json({ source: 'LTA GTFS-Realtime', feedTimestamp: tripResult.timestamp || alertResult.timestamp || 0, updatedAt: new Date().toISOString(), updates: updates.slice(0, 800), alerts: alerts.slice(0, 100) });
  } catch (error) {
    return res.status(502).json({ error: error instanceof Error ? error.message : 'Unable to load LTA train realtime.' });
  }
};
