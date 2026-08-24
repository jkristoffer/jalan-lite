const LTA_URL = 'https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival';

function minutesUntil(value) {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (!Number.isFinite(target)) return null;
  return Math.max(0, Math.round((target - Date.now()) / 60000));
}

function loadLabel(load) {
  if (load === 'SEA') return 'Seats';
  if (load === 'SDA') return 'Standing';
  if (load === 'LSD') return 'Limited';
  return '';
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=15, stale-while-revalidate=15');

  try {
    const url = new URL(req.url, 'https://jalan.local');
    const stopCode = (url.searchParams.get('stopCode') || '').trim();
    const requested = (url.searchParams.get('services') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);

    if (!/^\d{5}$/.test(stopCode)) {
      return res.status(400).json({ error: 'A valid 5-digit bus stop code is required.' });
    }

    const apiKey = process.env.LTA_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'LTA_API_KEY is not configured.' });
    }

    const ltaUrl = new URL(LTA_URL);
    ltaUrl.searchParams.set('BusStopCode', stopCode);

    const response = await fetch(ltaUrl, {
      headers: { AccountKey: apiKey, Accept: 'application/json' },
    });

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      return res.status(502).json({ error: `LTA request failed (${response.status}).`, detail });
    }

    const payload = await response.json();
    const services = (payload.Services || []).map((service) => {
      const buses = [service.NextBus, service.NextBus2, service.NextBus3];
      return {
        serviceNo: service.ServiceNo,
        operator: service.Operator || '',
        load: loadLabel(service.NextBus?.Load),
        arrivals: buses.map((bus) => minutesUntil(bus?.EstimatedArrival)),
        monitored: buses.map((bus) => bus?.Monitored === '1'),
      };
    });

    const byService = new Map(services.map((service) => [service.serviceNo, service]));
    const ordered = requested.length
      ? requested.map((serviceNo) => byService.get(serviceNo) || {
          serviceNo,
          operator: '',
          load: '',
          arrivals: [null, null, null],
          monitored: [false, false, false],
        })
      : services;

    return res.status(200).json({ stopCode, updatedAt: new Date().toISOString(), services: ordered });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unexpected error.' });
  }
}
