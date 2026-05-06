/**
 * BWT Express Server — Render deployment
 * Replaces all Netlify Functions with Express routes
 *
 * Routes:
 *   POST /api/search   — flight search via SearchAPI.io
 *   POST /api/quote    — quote request via Resend email
 *   GET  /api/airports — airport autocomplete (static)
 *   GET  /api/health   — health check
 *   GET  /*            — serve static HTML files from /public
 */

const express  = require('express');
const path     = require('path');
const crypto   = require('crypto');

const { normalizeSearchAPIResponse, sortOffers, assignBadges } = require('./lib/serpapi-normalizer');
const { getCached, setCached, logAccess } = require('./lib/supabase-cache');
const { check } = require('./lib/rate-limit');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// CORS
const ALLOWED_ORIGINS = [
  'https://businessworldtravel.com',
  'https://www.businessworldtravel.com',
  process.env.RENDER_EXTERNAL_URL,
  'http://localhost:3000',
].filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : '*';
  res.setHeader('Access-Control-Allow-Origin', allowed);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve static files from /public
// Serve static files — use multiple path strategies for reliability
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PUBLIC_DIR2 = path.join(process.cwd(), 'public');
const fs = require('fs');
const STATIC_DIR = fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : PUBLIC_DIR2;
console.log('[static] serving from:', STATIC_DIR, '| exists:', fs.existsSync(STATIC_DIR));
app.use(express.static(STATIC_DIR));

// ── Helpers ────────────────────────────────────────────────────────────────────
function getIP(req) {
  return (
    req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
    req.headers['x-real-ip'] ||
    req.connection?.remoteAddress ||
    'unknown'
  );
}

function log(level, fn, msg, data = {}) {
  console.log(JSON.stringify({ level, fn, msg, ts: new Date().toISOString(), ...data }));
}

// ── Constants ──────────────────────────────────────────────────────────────────
const SEARCHAPI_BASE = 'https://www.searchapi.io/api/v1/search';

const CABIN_CODE = {
  BUSINESS: 'business', FIRST: 'first',
  PREMIUM_ECONOMY: 'premium_economy', ECONOMY: 'economy',
};
const CABIN_MAP_IN = {
  business: 'BUSINESS', first: 'FIRST',
  premium_economy: 'PREMIUM_ECONOMY', economy: 'ECONOMY',
  BUSINESS: 'BUSINESS', FIRST: 'FIRST',
  PREMIUM_ECONOMY: 'PREMIUM_ECONOMY', ECONOMY: 'ECONOMY',
};

const CABIN_LABEL = {
  BUSINESS: 'Business Class', FIRST: 'First Class',
  PREMIUM_ECONOMY: 'Premium Economy', ECONOMY: 'Economy',
  business: 'Business Class', first: 'First Class',
};

const GUEST_LIMIT  = { max: 8,  windowMs: 60 * 60 * 1000 };
const USER_LIMIT   = { max: 40, windowMs: 60 * 60 * 1000 };
const GLOBAL_LIMIT = { max: 15, windowMs: 60 * 1000 };

// ── POST /api/cockpit-search (agent-only, higher limits) ────────────────────
// Same as /api/search but with:
//   - No guest/user rate limit (agents are trusted)
//   - Returns top 3 offers for comparison
//   - Includes raw price_insights

app.post('/api/cockpit-search', async (req, res) => {
  const { origin, destination, departureDate, cabin = 'business', adults = 1 } = req.body;
  if (!origin || !destination || !departureDate) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const apiKey = process.env.SEARCHAPI_KEY;
  if (!apiKey) return res.status(503).json({ error: 'SEARCHAPI_KEY not set' });

  const CABIN_CODE = {
    BUSINESS: 'business', FIRST: 'first',
    PREMIUM_ECONOMY: 'premium_economy', ECONOMY: 'economy',
    business: 'business', first: 'first', economy: 'economy',
  };

  try {
    const params = {
      engine: 'google_flights', api_key: apiKey,
      departure_id: origin.toUpperCase(),
      arrival_id: destination.toUpperCase(),
      outbound_date: departureDate,
      travel_class: CABIN_CODE[cabin] || 'business',
      adults: String(adults),
      currency: 'USD', hl: 'en', gl: 'us',
      flight_type: 'one_way',
    };
    const qs = new URLSearchParams(params);
    const raw = await fetch(`${SEARCHAPI_BASE}?${qs}`, { signal: AbortSignal.timeout(20000) });
    if (!raw.ok) throw new Error('SearchAPI ' + raw.status);
    const data = await raw.json();
    if (data.error) throw new Error(data.error);

    const all = [...(data.best_flights||[]), ...(data.other_flights||[])];
    const top3 = all.slice(0,3).map(f => ({
      price: f.price || 0,
      airline: f.flights?.[0]?.airline || '',
      code: (f.flights?.[0]?.flight_number||'').slice(0,2),
      airlineLogo: f.flights?.[0]?.airline_logo || '',
      flightNumber: f.flights?.[0]?.flight_number || '',
      stops: (f.flights?.length||1)-1,
      duration: f.total_duration ? Math.floor(f.total_duration/60)+'h '+(f.total_duration%60)+'m' : '',
      dep: f.flights?.[0]?.departure_airport?.id || origin,
      arr: f.flights?.[f.flights.length-1]?.arrival_airport?.id || destination,
      depTime: f.flights?.[0]?.departure_airport?.time || '',
      arrTime: f.flights?.[f.flights.length-1]?.arrival_airport?.time || '',
    }));

    return res.json({
      offers: top3,
      cheapest: top3.reduce((a,b) => a.price < b.price ? a : b, top3[0] || {}),
      priceInsights: data.price_insights || null,
    });
  } catch(e) {
    return res.status(502).json({ error: e.message });
  }
});

// ── GET /api/health ────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'BWT Platform',
    version: '2.0.0',
    timestamp: new Date().toISOString(),
    env: {
      searchapi:  !!process.env.SEARCHAPI_KEY,
      supabase:   !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY),
      resend:     !!process.env.RESEND_API_KEY,
    },
  });
});

// ── GET /api/airports ──────────────────────────────────────────────────────────
const AIRPORTS = [
  {iata:'JFK',city:'New York',name:'John F. Kennedy International',country:'United States',flag:'🇺🇸'},
  {iata:'EWR',city:'Newark',name:'Newark Liberty International',country:'United States',flag:'🇺🇸'},
  {iata:'LGA',city:'New York',name:'LaGuardia Airport',country:'United States',flag:'🇺🇸'},
  {iata:'BOS',city:'Boston',name:'Logan International',country:'United States',flag:'🇺🇸'},
  {iata:'IAD',city:'Washington DC',name:'Washington Dulles International',country:'United States',flag:'🇺🇸'},
  {iata:'DCA',city:'Washington DC',name:'Ronald Reagan Washington National',country:'United States',flag:'🇺🇸'},
  {iata:'BWI',city:'Baltimore',name:'Baltimore/Washington International',country:'United States',flag:'🇺🇸'},
  {iata:'MIA',city:'Miami',name:'Miami International',country:'United States',flag:'🇺🇸'},
  {iata:'FLL',city:'Fort Lauderdale',name:'Fort Lauderdale-Hollywood International',country:'United States',flag:'🇺🇸'},
  {iata:'PHL',city:'Philadelphia',name:'Philadelphia International',country:'United States',flag:'🇺🇸'},
  {iata:'ORD',city:'Chicago',name:"O'Hare International",country:'United States',flag:'🇺🇸'},
  {iata:'MDW',city:'Chicago',name:'Chicago Midway International',country:'United States',flag:'🇺🇸'},
  {iata:'ATL',city:'Atlanta',name:'Hartsfield-Jackson Atlanta International',country:'United States',flag:'🇺🇸'},
  {iata:'DTW',city:'Detroit',name:'Detroit Metropolitan Wayne County',country:'United States',flag:'🇺🇸'},
  {iata:'MSP',city:'Minneapolis',name:'Minneapolis-Saint Paul International',country:'United States',flag:'🇺🇸'},
  {iata:'CLT',city:'Charlotte',name:'Charlotte Douglas International',country:'United States',flag:'🇺🇸'},
  {iata:'IAH',city:'Houston',name:'George Bush Intercontinental',country:'United States',flag:'🇺🇸'},
  {iata:'DFW',city:'Dallas',name:'Dallas/Fort Worth International',country:'United States',flag:'🇺🇸'},
  {iata:'LAX',city:'Los Angeles',name:'Los Angeles International',country:'United States',flag:'🇺🇸'},
  {iata:'SFO',city:'San Francisco',name:'San Francisco International',country:'United States',flag:'🇺🇸'},
  {iata:'SEA',city:'Seattle',name:'Seattle-Tacoma International',country:'United States',flag:'🇺🇸'},
  {iata:'DEN',city:'Denver',name:'Denver International',country:'United States',flag:'🇺🇸'},
  {iata:'LAS',city:'Las Vegas',name:'Harry Reid International',country:'United States',flag:'🇺🇸'},
  {iata:'PHX',city:'Phoenix',name:'Phoenix Sky Harbor International',country:'United States',flag:'🇺🇸'},
  {iata:'MCO',city:'Orlando',name:'Orlando International',country:'United States',flag:'🇺🇸'},
  {iata:'YYZ',city:'Toronto',name:'Toronto Pearson International',country:'Canada',flag:'🇨🇦'},
  {iata:'YUL',city:'Montreal',name:'Montréal-Trudeau International',country:'Canada',flag:'🇨🇦'},
  {iata:'YVR',city:'Vancouver',name:'Vancouver International',country:'Canada',flag:'🇨🇦'},
  {iata:'YYC',city:'Calgary',name:'Calgary International',country:'Canada',flag:'🇨🇦'},
  {iata:'LHR',city:'London',name:'London Heathrow Airport',country:'United Kingdom',flag:'🇬🇧'},
  {iata:'LGW',city:'London',name:'London Gatwick Airport',country:'United Kingdom',flag:'🇬🇧'},
  {iata:'LCY',city:'London',name:'London City Airport',country:'United Kingdom',flag:'🇬🇧'},
  {iata:'MAN',city:'Manchester',name:'Manchester Airport',country:'United Kingdom',flag:'🇬🇧'},
  {iata:'EDI',city:'Edinburgh',name:'Edinburgh Airport',country:'United Kingdom',flag:'🇬🇧'},
  {iata:'CDG',city:'Paris',name:'Charles de Gaulle Airport',country:'France',flag:'🇫🇷'},
  {iata:'ORY',city:'Paris',name:'Paris Orly Airport',country:'France',flag:'🇫🇷'},
  {iata:'FRA',city:'Frankfurt',name:'Frankfurt Airport',country:'Germany',flag:'🇩🇪'},
  {iata:'MUC',city:'Munich',name:'Munich Airport',country:'Germany',flag:'🇩🇪'},
  {iata:'BER',city:'Berlin',name:'Berlin Brandenburg Airport',country:'Germany',flag:'🇩🇪'},
  {iata:'AMS',city:'Amsterdam',name:'Amsterdam Schiphol Airport',country:'Netherlands',flag:'🇳🇱'},
  {iata:'ZRH',city:'Zurich',name:'Zurich Airport',country:'Switzerland',flag:'🇨🇭'},
  {iata:'GVA',city:'Geneva',name:'Geneva Airport',country:'Switzerland',flag:'🇨🇭'},
  {iata:'VIE',city:'Vienna',name:'Vienna International Airport',country:'Austria',flag:'🇦🇹'},
  {iata:'BRU',city:'Brussels',name:'Brussels Airport',country:'Belgium',flag:'🇧🇪'},
  {iata:'DUB',city:'Dublin',name:'Dublin Airport',country:'Ireland',flag:'🇮🇪'},
  {iata:'MAD',city:'Madrid',name:'Adolfo Suárez Madrid-Barajas',country:'Spain',flag:'🇪🇸'},
  {iata:'BCN',city:'Barcelona',name:'Barcelona El Prat Airport',country:'Spain',flag:'🇪🇸'},
  {iata:'LIS',city:'Lisbon',name:'Lisbon Humberto Delgado Airport',country:'Portugal',flag:'🇵🇹'},
  {iata:'FCO',city:'Rome',name:'Rome Fiumicino Airport',country:'Italy',flag:'🇮🇹'},
  {iata:'MXP',city:'Milan',name:'Milan Malpensa Airport',country:'Italy',flag:'🇮🇹'},
  {iata:'CPH',city:'Copenhagen',name:'Copenhagen Airport',country:'Denmark',flag:'🇩🇰'},
  {iata:'ARN',city:'Stockholm',name:'Stockholm Arlanda Airport',country:'Sweden',flag:'🇸🇪'},
  {iata:'OSL',city:'Oslo',name:'Oslo Gardermoen Airport',country:'Norway',flag:'🇳🇴'},
  {iata:'HEL',city:'Helsinki',name:'Helsinki-Vantaa Airport',country:'Finland',flag:'🇫🇮'},
  {iata:'ATH',city:'Athens',name:'Athens International Airport',country:'Greece',flag:'🇬🇷'},
  {iata:'IST',city:'Istanbul',name:'Istanbul Airport',country:'Turkey',flag:'🇹🇷'},
  {iata:'TLV',city:'Tel Aviv',name:'Ben Gurion International Airport',country:'Israel',flag:'🇮🇱'},
  {iata:'DXB',city:'Dubai',name:'Dubai International Airport',country:'UAE',flag:'🇦🇪'},
  {iata:'AUH',city:'Abu Dhabi',name:'Abu Dhabi International Airport',country:'UAE',flag:'🇦🇪'},
  {iata:'DOH',city:'Doha',name:'Hamad International Airport',country:'Qatar',flag:'🇶🇦'},
  {iata:'RUH',city:'Riyadh',name:'King Khalid International Airport',country:'Saudi Arabia',flag:'🇸🇦'},
  {iata:'NRT',city:'Tokyo',name:'Tokyo Narita International Airport',country:'Japan',flag:'🇯🇵'},
  {iata:'HND',city:'Tokyo',name:'Tokyo Haneda Airport',country:'Japan',flag:'🇯🇵'},
  {iata:'ICN',city:'Seoul',name:'Incheon International Airport',country:'South Korea',flag:'🇰🇷'},
  {iata:'PEK',city:'Beijing',name:'Beijing Capital International Airport',country:'China',flag:'🇨🇳'},
  {iata:'PVG',city:'Shanghai',name:'Shanghai Pudong International Airport',country:'China',flag:'🇨🇳'},
  {iata:'HKG',city:'Hong Kong',name:'Hong Kong International Airport',country:'Hong Kong',flag:'🇭🇰'},
  {iata:'SIN',city:'Singapore',name:'Singapore Changi Airport',country:'Singapore',flag:'🇸🇬'},
  {iata:'BKK',city:'Bangkok',name:'Suvarnabhumi Airport',country:'Thailand',flag:'🇹🇭'},
  {iata:'KUL',city:'Kuala Lumpur',name:'Kuala Lumpur International Airport',country:'Malaysia',flag:'🇲🇾'},
  {iata:'DEL',city:'Delhi',name:'Indira Gandhi International Airport',country:'India',flag:'🇮🇳'},
  {iata:'BOM',city:'Mumbai',name:'Chhatrapati Shivaji Maharaj International',country:'India',flag:'🇮🇳'},
  {iata:'SYD',city:'Sydney',name:'Sydney Kingsford Smith Airport',country:'Australia',flag:'🇦🇺'},
  {iata:'MEL',city:'Melbourne',name:'Melbourne Airport',country:'Australia',flag:'🇦🇺'},
  {iata:'JNB',city:'Johannesburg',name:'O.R. Tambo International Airport',country:'South Africa',flag:'🇿🇦'},
  {iata:'NBO',city:'Nairobi',name:'Jomo Kenyatta International Airport',country:'Kenya',flag:'🇰🇪'},
  {iata:'CAI',city:'Cairo',name:'Cairo International Airport',country:'Egypt',flag:'🇪🇬'},
  {iata:'CMN',city:'Casablanca',name:'Mohammed V International Airport',country:'Morocco',flag:'🇲🇦'},
  {iata:'GRU',city:'São Paulo',name:'São Paulo Guarulhos International',country:'Brazil',flag:'🇧🇷'},
  {iata:'EZE',city:'Buenos Aires',name:'Ministro Pistarini International',country:'Argentina',flag:'🇦🇷'},
  {iata:'BOG',city:'Bogotá',name:'El Dorado International Airport',country:'Colombia',flag:'🇨🇴'},
  {iata:'LIM',city:'Lima',name:'Jorge Chávez International Airport',country:'Peru',flag:'🇵🇪'},
  {iata:'MEX',city:'Mexico City',name:'Mexico City International Airport',country:'Mexico',flag:'🇲🇽'},
  {iata:'CUN',city:'Cancún',name:'Cancún International Airport',country:'Mexico',flag:'🇲🇽'},
];

const POPULAR_IATA = ['JFK','EWR','LHR','CDG','FRA','AMS','ZRH','DUB','MUC','MAD','FCO','LAX','ORD','BOS','MIA','YYZ','DXB','DOH','SIN','NRT'];

app.get('/api/airports', (req, res) => {
  const q     = (req.query.q || '').trim().toLowerCase();
  const limit = Math.min(parseInt(req.query.limit || '8'), 20);

  if (q.length < 1) {
    const popular = POPULAR_IATA.map(c => AIRPORTS.find(a => a.iata === c)).filter(Boolean);
    return res.json(popular.slice(0, limit));
  }

  const results = AIRPORTS.filter(a =>
    a.iata.toLowerCase().startsWith(q) ||
    a.city.toLowerCase().includes(q) ||
    a.name.toLowerCase().includes(q) ||
    a.country.toLowerCase().includes(q)
  ).slice(0, limit);

  res.json(results);
});


// ── Demo offer generator (used when SEARCHAPI_KEY not set) ──────────────────
function generateDemoOffers(orig, dest, dep) {
  const airlines = [
    { name:'British Airways', iata:'BA', price:4210 },
    { name:'Lufthansa',       iata:'LH', price:3890 },
    { name:'Air France',      iata:'AF', price:4050 },
    { name:'United Airlines', iata:'UA', price:3650 },
    { name:'American Airlines',iata:'AA', price:3820 },
  ];
  return airlines.map((a, i) => ({
    id: `demo-${i}`,
    validatingCarrier: a.iata,
    groupName: a.name,
    totalPrice: a.price + Math.round((Math.random()-0.5)*200),
    currency: 'USD',
    cabin: 'BUSINESS',
    isRoundTrip: false,
    outboundDuration: `${7+i}h ${10+i*5}m`,
    totalStops: i === 0 ? 0 : 1,
    _sortScore: i,
    journeys: [{
      origin: orig, destination: dest,
      segments: [{
        airline: { name: a.name, iata: a.iata },
        departure: { airport: orig, city: orig, datetime: dep + 'T10:00:00' },
        arrival:   { airport: dest, city: dest, datetime: dep + 'T22:00:00' },
        duration: `${7+i}h ${10+i*5}m`,
        flightNumber: a.iata + (100+i*11),
        aircraft: 'Boeing 777',
        cabin: 'Business',
        baggageAllowance: '2 bags',
      }]
    }],
    badges: ['business'],
    source: 'demo',
  }));
}

// ── POST /api/search ───────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const ip     = getIP(req);
  const ipHash = crypto.createHash('sha256')
    .update(ip + (process.env.IP_SALT || 'bwt')).digest('hex').slice(0, 16);

  // Global rate limit
  const globalRL = check(`global:${ip}`, GLOBAL_LIMIT.max, GLOBAL_LIMIT.windowMs);
  if (!globalRL.allowed) {
    return res.status(429).json({ error: 'Too many searches. Please wait a moment.' });
  }

  const {
    origin, destination, departureDate, returnDate,
    adults = 1, cabin = 'business', stops, sort = 'best', isGuest = true,
  } = req.body;

  // Validate
  if (!origin || !destination || !departureDate) {
    return res.status(400).json({ error: 'Missing required fields: origin, destination, departureDate' });
  }
  if (!/^[A-Z]{3}$/i.test(origin) || !/^[A-Z]{3}$/i.test(destination)) {
    return res.status(400).json({ error: 'origin and destination must be 3-letter IATA codes' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(departureDate)) {
    return res.status(400).json({ error: 'departureDate must be YYYY-MM-DD' });
  }

  const orig        = origin.toUpperCase();
  const dest        = destination.toUpperCase();
  const travelClass = CABIN_MAP_IN[cabin] || 'BUSINESS';
  const tripType    = returnDate ? 'round' : 'oneway';

  // Per-IP rate limit
  const rl = check(`search:${ip}`,
    isGuest ? GUEST_LIMIT.max : USER_LIMIT.max,
    isGuest ? GUEST_LIMIT.windowMs : USER_LIMIT.windowMs);
  if (!rl.allowed) {
    return res.status(429).json({ error: isGuest
      ? 'Free search limit reached. Sign up for more searches.'
      : 'Search limit reached. Please try again in an hour.' });
  }

  // 1. Check Supabase cache
  let cached;
  try { cached = await getCached({ origin: orig, destination: dest, cabin: travelClass, departureDate }); }
  catch (e) { log('warn', 'search', 'cache read failed', { error: e.message }); cached = null; }

  if (cached?.status === 'fresh') {
    log('info', 'search', 'cache fresh', { orig, dest });
    const sorted = assignBadges(sortOffers(cached.offers, sort));
    return res.json({
      offers: sorted, fromCache: true, cacheStatus: 'fresh',
      cachedAt: cached.cachedAt, cacheAgeHours: cached.ageHours,
      count: sorted.length, priceInsights: cached.priceInsights || null,
    });
  }

  // 2. Live SearchAPI.io call
  const apiKey = process.env.SEARCHAPI_KEY;
  if (!apiKey) {
    log('warn', 'search', 'SEARCHAPI_KEY not set — returning demo data');
    // Return demo offers so the UI still works
    const demoOffers = generateDemoOffers(orig, dest, departureDate);
    return res.json({ offers: demoOffers, source: 'demo', message: 'Live search unavailable — showing sample fares' });
  }

  try {
    log('info', 'search', 'calling searchapi', { orig, dest, departureDate, travelClass });

    const params = {
      engine:        'google_flights',
      api_key:       apiKey,
      departure_id:  orig,
      arrival_id:    dest,
      outbound_date: departureDate,
      travel_class:  CABIN_CODE[travelClass] || 'business',
      adults:        String(parseInt(adults) || 1),
      currency:      'USD',
      hl:            'en',
      gl:            'us',
      flight_type:   tripType === 'round' ? 'round_trip' : 'one_way',
    };
    if (returnDate)  params.return_date = returnDate;
    if (stops === 0) params.stops = 'nonstop';

    const qs  = new URLSearchParams(params);
    const url = `${SEARCHAPI_BASE}?${qs.toString()}`;
    const raw = await fetch(url, { signal: AbortSignal.timeout(25000) });

    if (!raw.ok) {
      const txt = await raw.text();
      throw new Error(`SearchAPI HTTP ${raw.status}: ${txt.slice(0, 300)}`);
    }
    const data = await raw.json();
    if (data.error) throw new Error(`SearchAPI: ${data.error}`);

    // SearchAPI round trip: price includes both legs
    // But we need a second call per offer using departure_token to get return leg details
    if (tripType === 'round' && returnDate) {
      const allGroups = [...(data.best_flights||[]), ...(data.other_flights||[])];
      // Fetch return leg details for top 8 offers in parallel
      const returnCalls = allGroups.slice(0, 8)
        .filter(g => g.departure_token)
        .map(async g => {
          try {
            const rp = new URLSearchParams({
              ...params,
              departure_token: g.departure_token,
            });
            const rraw = await fetch(`${SEARCHAPI_BASE}?${rp.toString()}`,
              { signal: AbortSignal.timeout(15000) });
            if (!rraw.ok) return null;
            const rdata = await rraw.json();
            if (rdata.error) return null;
            // Pick best return flight
            const returnFlights = [...(rdata.best_flights||[]), ...(rdata.other_flights||[])];
            if (returnFlights.length) g._returnFlight = returnFlights[0];
          } catch { /* silent — outbound still shows */ }
        });
      await Promise.all(returnCalls);
    }

    const { offers, priceInsights } = normalizeSearchAPIResponse(data, travelClass, tripType);

    if (!offers.length) {
      if (cached?.status === 'stale') return serveStale(res, cached, sort);
      return res.json({ offers: [], fromCache: false, count: 0,
        message: 'No flights found for this route and date.', priceInsights });
    }

    // Save to cache async
    setCached({ origin: orig, destination: dest, cabin: travelClass,
      departureDate, offers, source: 'searchapi', priceInsights })
      .catch(e => log('warn', 'search', 'cache write failed', { error: e.message }));

    const sorted = assignBadges(sortOffers(offers, sort));
    log('info', 'search', 'searchapi success', { orig, dest, count: sorted.length });
    // Debug: log first offer layover data
    const firstOffer = sorted[0];
    if (firstOffer?.layovers?.length) {
      log('info', 'search', 'layover sample', { layovers: firstOffer.layovers.slice(0,2) });
    }

    return res.json({
      offers: sorted, fromCache: false, count: sorted.length, priceInsights,
      meta: { origin: orig, destination: dest, date: departureDate,
              returnDate: returnDate || null, cabin: travelClass,
              adults: parseInt(adults) || 1, source: 'searchapi' },
    });

  } catch (e) {
    log('error', 'search', e.message, { orig, dest });
    if (cached?.status === 'stale') return serveStale(res, cached, sort);
    return res.status(502).json({
      error: "Flight search temporarily unavailable. Please WhatsApp or call us and we'll find your fare.",
    });
  }
});

function serveStale(res, cached, sort) {
  const sorted = assignBadges(sortOffers(cached.offers, sort));
  return res.json({
    offers: sorted, fromCache: true, cacheStatus: 'stale',
    cachedAt: cached.cachedAt, cacheAgeHours: cached.ageHours,
    staleMessage: `Fares from ${Math.round(cached.ageHours)} hours ago — live data temporarily unavailable.`,
    count: sorted.length, priceInsights: cached.priceInsights || null,
  });
}

// ── POST /api/quote ────────────────────────────────────────────────────────────
const AGENT_EMAIL = process.env.AGENT_EMAIL  || 'quotes@businessworldtravel.com';
const FROM_EMAIL  = process.env.FROM_EMAIL   || 'noreply@businessworldtravel.com';
const RESEND_KEY  = process.env.RESEND_API_KEY;

app.post('/api/quote', async (req, res) => {
  // Handle gate access notifications
  if (req.body && req.body.type === 'gate_access') {
    const { email, route, dep, source } = req.body;
    log('info', 'gate', `New access: ${email} | ${route} | ${dep} | ${source}`);
    // Send notification email to BWT team
    if (process.env.RESEND_API_KEY) {
      try {
        // 1. Notify BWT team
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {'Content-Type':'application/json','Authorization':`Bearer ${process.env.RESEND_API_KEY}`},
          body: JSON.stringify({
            from: 'BWT Platform <onboarding@resend.dev>',
            to: ['quotes@businessworldtravel.com'],
            subject: `New fare access: ${email} — ${route}`,
            html: `<h2>New fare access request</h2><p><strong>Email:</strong> ${email}</p><p><strong>Route:</strong> ${route}</p><p><strong>Date:</strong> ${dep}</p><p><strong>Source:</strong> ${source}</p>`
          })
        });
        // 2. Confirm to user
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {'Content-Type':'application/json','Authorization':`Bearer ${process.env.RESEND_API_KEY}`},
          body: JSON.stringify({
            from: 'Business World Travel <onboarding@resend.dev>',
            to: [email],
            subject: 'You now have full access to BWT fares',
            html: `<p>Hi,</p><p>You now have full access to all published fares on <a href="https://bwt-platform.onrender.com">businessworldtravel.com</a>.</p><p>Your route: <strong>${route}</strong></p><p>If you'd like us to check if we can beat the published fare, simply click <strong>"Check If We Can Beat This"</strong> on any flight card.</p><p>We respond within the hour.</p><p>— The BWT Team</p><p>📞 (212) 913-0450</p>`
          })
        });
      } catch(e) { log('warn','gate','Email notify failed: '+e.message); }
    }
    return res.json({ ok: true });
  }
  const ip = getIP(req);
  const rl = check(`quote:${ip}`, 5, 60 * 60 * 1000);
  if (!rl.allowed) {
    return res.status(429).json({ error: 'Too many quote requests. Please contact us directly.' });
  }

  const {
    firstName, lastName, email, phone, company,
    origin, originName, destination, destinationName,
    departureDate, returnDate, tripType,
    adults = 1, cabin = 'BUSINESS',
    selectedOffer, flexibility, notes,
  } = req.body;

  if (!firstName || !lastName || !email || !origin || !destination || !departureDate) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  const quoteId  = `BWT-${new Date().toISOString().slice(0,10).replace(/-/g,'')}` +
                   `-${Math.random().toString(36).substring(2,6).toUpperCase()}`;
  const cabinLbl = CABIN_LABEL[cabin] || cabin;
  const tripLbl  = tripType === 'round' ? 'Round Trip' : tripType === 'multi' ? 'Multi-City' : 'One Way';
  const routeLbl = `${originName||origin} (${origin}) → ${destinationName||destination} (${destination})`;
  const dateLbl  = returnDate ? `${departureDate} → ${returnDate}` : departureDate;

  log('info', 'quote', 'received', { quoteId, email, origin, destination });

  try {
    if (RESEND_KEY) {
      // Agent email
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL, to: AGENT_EMAIL,
          subject: `🎯 New Quote #${quoteId} — ${routeLbl} · ${cabinLbl}`,
          html: agentEmailHTML({ quoteId, firstName, lastName, email, phone, company,
            routeLbl, dateLbl, tripLbl, cabinLbl, adults, flexibility, notes,
            selectedOffer, origin, destination, departureDate, returnDate }),
        }),
      });
      // Customer confirmation
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: FROM_EMAIL, to: email,
          subject: `Your Business World Travel quote request — Ref #${quoteId}`,
          html: customerEmailHTML({ quoteId, firstName, routeLbl, dateLbl, cabinLbl, adults, tripLbl }),
        }),
      });
    } else {
      log('warn', 'quote', 'RESEND_API_KEY not set — email skipped');
    }

    log('info', 'quote', 'success', { quoteId });
    return res.json({ success: true, quoteId,
      message: `Quote request received. Reference #${quoteId}.` });

  } catch (e) {
    log('error', 'quote', e.message);
    return res.status(500).json({ error: 'Failed to submit. Please email quotes@businessworldtravel.com' });
  }
});

// ── Email templates (same as original) ────────────────────────────────────────
function agentEmailHTML(d) {
  const offer = d.selectedOffer;
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body{font-family:Arial,sans-serif;color:#1a2235;background:#f4f5f7}
.wrap{max-width:600px;margin:0 auto;background:#fff}
.header{background:#0c1220;padding:24px 32px;color:#fff}
.header h1{margin:0;font-size:20px;color:#c8a84b}
.header p{margin:4px 0 0;font-size:13px;color:#7a8ba0}
.body{padding:32px}
.badge{display:inline-block;background:#c8a84b;color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:4px;margin-bottom:16px}
.section{margin-bottom:24px;border:1px solid #e5e9ef;border-radius:8px;overflow:hidden}
.section-title{background:#f8f9fa;padding:10px 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:#7a8ba0;border-bottom:1px solid #e5e9ef}
.section-body{padding:16px}
.row{display:flex;justify-content:space-between;margin-bottom:8px;font-size:14px}
.row .label{color:#7a8ba0}.row .value{font-weight:600;color:#0c1220}
.cta{background:#c8a84b;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;margin-top:16px}
.footer{background:#f8f9fa;padding:16px 32px;font-size:12px;color:#7a8ba0;border-top:1px solid #e5e9ef}
</style></head><body>
<div class="wrap">
  <div class="header"><h1>Business World Travel</h1><p>New Quote Request — Action Required</p></div>
  <div class="body">
    <div class="badge">Quote #${d.quoteId}</div>
    <div class="section">
      <div class="section-title">Trip Details</div>
      <div class="section-body">
        <div class="row"><span class="label">Route</span><span class="value">${d.routeLbl}</span></div>
        <div class="row"><span class="label">Dates</span><span class="value">${d.dateLbl}</span></div>
        <div class="row"><span class="label">Cabin</span><span class="value">${d.cabinLbl}</span></div>
        <div class="row"><span class="label">Passengers</span><span class="value">${d.adults} Adult${d.adults>1?'s':''}</span></div>
        ${d.flexibility?`<div class="row"><span class="label">Flexibility</span><span class="value">${d.flexibility}</span></div>`:''}
      </div>
    </div>
    <div class="section">
      <div class="section-title">Customer</div>
      <div class="section-body">
        <div class="row"><span class="label">Name</span><span class="value">${d.firstName} ${d.lastName}</span></div>
        <div class="row"><span class="label">Email</span><span class="value"><a href="mailto:${d.email}">${d.email}</a></span></div>
        ${d.phone?`<div class="row"><span class="label">Phone</span><span class="value">${d.phone}</span></div>`:''}
        ${d.company?`<div class="row"><span class="label">Company</span><span class="value">${d.company}</span></div>`:''}
      </div>
    </div>
    ${d.notes?`<div class="section"><div class="section-title">Notes</div><div class="section-body"><p style="margin:0;font-size:14px">${d.notes}</p></div></div>`:''}
    ${offer?`<div class="section"><div class="section-title">Selected Flight</div><div class="section-body">
      <div class="row"><span class="label">Airline</span><span class="value">${offer.carrierName||offer.validatingCarrier}</span></div>
      <div class="row"><span class="label">Price Shown</span><span class="value">$${offer.totalPrice?.toLocaleString()} ${offer.currency||'USD'}</span></div>
      <p style="font-size:12px;color:#c0392b;margin:8px 0 0">⚠ Reprice before quoting client.</p>
    </div></div>`:''}
    <a href="mailto:${d.email}?subject=Re: Quote %23${d.quoteId}" class="cta">Reply to Customer</a>
  </div>
  <div class="footer">Quote #${d.quoteId} · ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} ET · Business World Travel</div>
</div></body></html>`;
}

function customerEmailHTML(d) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
body{font-family:Arial,sans-serif;color:#1a2235;background:#f4f5f7}
.wrap{max-width:600px;margin:0 auto;background:#fff}
.header{background:#0c1220;padding:32px;text-align:center}
.header h1{margin:0;font-size:22px;color:#c8a84b}
.body{padding:40px 32px}
.ref-box{background:#fffbf0;border:1px solid rgba(200,168,75,.4);border-radius:8px;padding:20px;text-align:center;margin:24px 0}
.ref{font-size:28px;font-weight:700;color:#c8a84b;letter-spacing:.1em}
.detail-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #f0f2f5;font-size:14px}
.detail-row:last-child{border-bottom:none}
.detail-label{color:#7a8ba0}.detail-value{font-weight:600}
.footer{background:#0c1220;padding:24px;text-align:center;color:#7a8ba0;font-size:12px}
.footer a{color:#c8a84b;text-decoration:none}
</style></head><body>
<div class="wrap">
  <div class="header"><h1>Business World Travel</h1></div>
  <div class="body">
    <p style="font-size:16px;margin:0 0 8px">Hi ${d.firstName},</p>
    <p style="font-size:14px;color:#4a5568;margin:0 0 24px">Thank you — our specialists are working on your quote.</p>
    <div class="ref-box"><div class="ref">#${d.quoteId}</div><p style="margin:4px 0 0;font-size:13px;color:#7a8ba0">Your quote reference</p></div>
    <div style="border:1px solid #e5e9ef;border-radius:8px;padding:16px;margin-bottom:24px">
      <div class="detail-row"><span class="detail-label">Route</span><span class="detail-value">${d.routeLbl}</span></div>
      <div class="detail-row"><span class="detail-label">Dates</span><span class="detail-value">${d.dateLbl}</span></div>
      <div class="detail-row"><span class="detail-label">Cabin</span><span class="detail-value">${d.cabinLbl}</span></div>
      <div class="detail-row"><span class="detail-label">Passengers</span><span class="detail-value">${d.adults} Adult${d.adults>1?'s':''}</span></div>
    </div>
    <p style="font-size:14px;color:#4a5568">Questions? <a href="mailto:quotes@businessworldtravel.com" style="color:#c8a84b">quotes@businessworldtravel.com</a></p>
  </div>
  <div class="footer">
    <p style="margin:0 0 4px">Business World Travel · 5 Penn Plaza, New York, NY</p>
    <p style="margin:0"><a href="https://businessworldtravel.com">businessworldtravel.com</a></p>
  </div>
</div></body></html>`;
}

// ── SPA fallback — serve index.html for unknown routes ─────────────────────────
app.get('*', (req, res) => {
  // Don't serve index for API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  // Serve specific HTML files
  const htmlFiles = {
    '/portal':       'portal.html',
    '/portal.html':  'portal.html',
    '/agents':       'agents.html',
    '/agents.html':  'agents.html',
    '/fare-admin':   'fare-admin.html',
    '/cockpit':      'agent-cockpit.html',
    '/agent-cockpit.html': 'agent-cockpit.html',
  };
  const file = htmlFiles[req.path];
  if (file) return res.sendFile(path.join(STATIC_DIR, file));
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ BWT Server running on port ${PORT}`);
  console.log(`   SearchAPI: ${process.env.SEARCHAPI_KEY ? '✓ configured' : '✗ NOT SET'}`);
  console.log(`   Supabase:  ${process.env.SUPABASE_URL  ? '✓ configured' : '✗ not set (cache disabled)'}`);
  console.log(`   Resend:    ${process.env.RESEND_API_KEY ? '✓ configured' : '✗ not set (email disabled)'}`);
});
