/**
 * serpapi-normalizer.js
 *
 * Maps SerpApi Google Flights response → BWT NormalizedOffer schema
 * (same schema the results page expects — previously produced by Amadeus normalizer)
 *
 * SerpApi response key structures used:
 *   best_flights[]   — Google's top picks
 *   other_flights[]  — remaining results
 *   price_insights   — { lowest_price, price_level, typical_price_range }
 *
 * Each flight group:
 *   flights[]        — array of segments
 *   total_duration   — integer minutes
 *   layovers[]       — array of { duration, name, id }
 *   price            — integer USD
 *   type             — "Round trip" | "One way"
 *   airline_logo     — URL
 *   departure_token  — string (used for return leg search)
 *   extensions[]     — ["Checked baggage for a fee", "Bag and fare conditions..."]
 *
 * Each segment (flights[]):
 *   departure_airport: { name, id, time }
 *   arrival_airport:   { name, id, time }
 *   duration           — integer minutes
 *   airplane           — e.g. "Boeing 787"
 *   airline            — e.g. "United Airlines"
 *   airline_logo       — URL
 *   travel_class       — e.g. "Business"
 *   flight_number      — e.g. "UA 900"
 *   extensions[]       — ["Flat bed seat", "Power & USB outlets", ...]
 *   legroom            — e.g. "76 in"
 *   overnight          — boolean
 *   often_delayed_by_over_30_min — boolean
 */

const CABIN_RANK = { FIRST: 4, BUSINESS: 3, PREMIUM_ECONOMY: 2, ECONOMY: 1 };

const CABIN_MAP = {
  'Business':          'BUSINESS',
  'First':             'FIRST',
  'Premium economy':   'PREMIUM_ECONOMY',
  'Economy':           'ECONOMY',
};

/**
 * Normalize a full SerpApi Google Flights response
 * @param {object} raw           — full SerpApi JSON response
 * @param {string} requestedCabin — 'BUSINESS' | 'FIRST' | 'PREMIUM_ECONOMY' | 'ECONOMY'
 * @param {string} tripType       — 'round' | 'oneway'
 * @returns {{ offers: NormalizedOffer[], priceInsights: object|null }}
 */
function normalizeSearchAPIResponse(raw, requestedCabin = 'BUSINESS', tripType = 'round') {
  const bestFlights  = raw.best_flights  || [];
  const otherFlights = raw.other_flights || [];
  const allGroups    = [...bestFlights, ...otherFlights];

  const offers = allGroups
    .map((group, idx) => normalizeGroup(group, idx, requestedCabin, tripType, idx < bestFlights.length))
    .filter(Boolean);

  return {
    offers,
    priceInsights: raw.price_insights || null,
  };
}

function normalizeGroup(group, idx, requestedCabin, tripType, isBest) {
  try {
    const segments     = group.flights || [];
    const layovers     = group.layovers || [];
    const totalPrice   = group.price || 0;
    const durationMins = group.total_duration || segments.reduce((s, f) => s + (f.duration || 0), 0);
    const durationStr  = formatMins(durationMins);

    if (!segments.length) return null;

    // Carrier — use first segment's airline
    const firstSeg     = segments[0];
    const lastSeg      = segments[segments.length - 1];
    const carrierCode  = extractCarrierCode(firstSeg.flight_number || '');
    const carrierName  = firstSeg.airline || carrierCode;
    const airlineLogo  = firstSeg.airline_logo || group.airline_logo || '';

    // Cabin detection
    const detectedCabin = CABIN_MAP[firstSeg.travel_class] || requestedCabin;

    // Build normalized segments
    const normalizedSegments = segments.map((seg, i) =>
      normalizeSegment(seg, i, layovers, i)
    );

    // Departure / arrival of full journey
    const dep = firstSeg.departure_airport;
    const arr = lastSeg.arrival_airport;

    // Build outbound journey
    const journey = {
      index:       0,
      direction:   'outbound',
      duration:    durationStr,
      durationRaw: durationMins,
      origin:      dep?.id || '',
      destination: arr?.id || '',
      originCity:  dep?.name || dep?.id || '',
      destCity:    arr?.name || arr?.id || '',
      depTime:     dep?.time || '',
      arrTime:     arr?.time || '',
      stops:       segments.length - 1,
      segments:    normalizedSegments,
    };

    // Build return journey if available (from second SearchAPI call)
    let returnJourney = null;
    if (group._returnFlight) {
      const rf = group._returnFlight;
      const rSegs = rf.flights || [];
      const rLays = rf.layovers || [];
      const rFirst = rSegs[0] || {};
      const rLast  = rSegs[rSegs.length-1] || rFirst;
      const rDurMins = rf.total_duration || rSegs.reduce((s,f)=>s+(f.duration||0),0);
      returnJourney = {
        index:       1,
        direction:   'inbound',
        duration:    formatMins(rDurMins),
        durationRaw: rDurMins,
        origin:      rFirst.departure_airport?.id || '',
        destination: rLast.arrival_airport?.id || '',
        originCity:  rFirst.departure_airport?.name || '',
        destCity:    rLast.arrival_airport?.name || '',
        depTime:     rFirst.departure_airport?.time || '',
        arrTime:     rLast.arrival_airport?.time || '',
        stops:       rSegs.length - 1,
        segments:    rSegs.map((seg, i) => normalizeSegment(seg, i, rLays, i)),
      };
    }

    // Baggage from extensions
    const baggage = extractBaggageFromExtensions(group.extensions || [], segments);

    // Fare features
    const features = extractFeatures(segments);

    // Refundable — check extensions
    const refundable = extractRefundable(group.extensions || []);

    // SearchAPI round trip: price field already includes both legs
    // The 'type' field tells us: "Round trip" or "One way"
    const isRoundTrip = (group.type || '').toLowerCase().includes('round');

    return {
      id:               `serp_${idx}_${totalPrice}`,
      source:           'serpapi',
      totalPrice,
      isRoundTrip,
      perPaxPrice:      totalPrice,
      basePrice:        Math.round(totalPrice * 0.8),
      taxes:            Math.round(totalPrice * 0.2),
      currency:         'USD',
      cabin:            detectedCabin,
      requestedCabin,
      cabinMatch:       detectedCabin === requestedCabin,
      validatingCarrier: carrierCode,
      carrierName,
      airlineLogo,
      journeys:         returnJourney ? [journey, returnJourney] : [journey],
      totalStops:       segments.length - 1,
      outboundDuration: durationStr,
      inboundDuration:  returnJourney?.duration || null,
      baggageSummary:   baggage,
      fareConditions: {
        refundable,
        changeable:   null,
        fareFamily:   null,
        fareBasis:    null,
        amenities:    features,
      },
      seatsAvailable:   null,
      lastTicketingDate: null,
      instantTicketing: false,
      refundable,
      changeable:       null,
      // SerpApi specific
      departureToken:   group.departure_token || null,
      isBestFlight:     isBest,
      legroom:          firstSeg.legroom || null,
      overnight:        segments.some(s => s.overnight),
      oftenDelayed:     segments.some(s => s.often_delayed_by_over_30_min),
      layovers:         layovers.map(l => ({
        airport: l.id,
        name:    l.name,
        duration: formatMins(l.duration || 0),
      })),
      badges: [],
      _raw: group,
    };
  } catch (e) {
    console.error('[serpapi-normalizer] error normalizing group:', e.message);
    return null;
  }
}

function normalizeSegment(seg, idx, layovers, layoverIdx) {
  const dep = seg.departure_airport || {};
  const arr = seg.arrival_airport   || {};
  const carrierCode = extractCarrierCode(seg.flight_number || '');

  return {
    id:           String(idx),
    flightNumber: seg.flight_number || '',
    carrier: {
      code: carrierCode,
      name: seg.airline || carrierCode,
      logo: seg.airline_logo || '',
    },
    operating:    null,
    aircraft:     seg.airplane || '',
    departure: {
      airport:  dep.id   || '',
      terminal: dep.terminal || null,
      datetime: dep.time || '',
      city:     dep.name || dep.id || '',
    },
    arrival: {
      airport:  arr.id   || '',
      terminal: arr.terminal || null,
      datetime: arr.time || '',
      city:     arr.name || arr.id || '',
    },
    duration:    formatMins(seg.duration || 0),
    durationRaw: seg.duration || 0,
    stops:       0,
    cabin:       CABIN_MAP[seg.travel_class] || 'BUSINESS',
    blacklisted: false,
    legroom:     seg.legroom || null,
    overnight:   seg.overnight || false,
    extensions:  seg.extensions || [],
    // Layover after this segment (if any)
    layoverAfter: layovers[layoverIdx] ? {
      airport:  layovers[layoverIdx].id,
      name:     layovers[layoverIdx].name,
      duration: formatMins(layovers[layoverIdx].duration || 0),
    } : null,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractCarrierCode(flightNumber) {
  // "UA 900" → "UA" | "BA123" → "BA"
  const m = flightNumber.match(/^([A-Z]{2})\s?\d/);
  return m ? m[1] : flightNumber.slice(0, 2);
}

function formatMins(totalMins) {
  if (!totalMins) return '';
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function extractBaggageFromExtensions(groupExtensions, segments) {
  const allExt = [
    ...groupExtensions,
    ...segments.flatMap(s => s.extensions || []),
  ];

  const bagStr = allExt.find(e =>
    /carry.?on|checked|bag|luggage/i.test(e)
  );
  const included = allExt.some(e =>
    /checked bag.*included|1 bag|2 bag|bag.*free/i.test(e)
  );
  const notIncluded = allExt.some(e =>
    /baggage for a fee|bags? not included/i.test(e)
  );

  return {
    summary:    bagStr || (included ? 'Checked bag included' : 'Check airline policy'),
    perSegment: [],
    included:   included && !notIncluded,
  };
}

function extractFeatures(segments) {
  const allExt = segments.flatMap(s => s.extensions || []);
  return allExt.map(desc => ({
    description:  desc,
    isChargeable: /fee|extra charge|for a fee/i.test(desc),
    amenityType:  categorizeAmenity(desc),
  }));
}

function categorizeAmenity(desc) {
  if (/wi.?fi|internet/i.test(desc)) return 'WIFI';
  if (/power|usb|outlet/i.test(desc)) return 'POWER';
  if (/video|entertainment|screen/i.test(desc)) return 'ENTERTAINMENT';
  if (/seat|lie.?flat|flat.?bed|legroom/i.test(desc)) return 'SEAT';
  if (/bag|luggage/i.test(desc)) return 'BAGGAGE';
  if (/meal|food|drink/i.test(desc)) return 'MEAL';
  return 'OTHER';
}

function extractRefundable(extensions) {
  if (extensions.some(e => /fully refundable/i.test(e))) return true;
  if (extensions.some(e => /non.?refundable|no refund/i.test(e))) return false;
  return null;
}

// ── Sort + Badges (identical logic to Amadeus normalizer) ────────────────────

function sortOffers(offers, mode = 'best') {
  const sorted = [...offers];
  const parseDur = str => {
    if (!str) return 9999;
    const h = str.match(/(\d+)h/);
    const m = str.match(/(\d+)m/);
    return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
  };
  switch (mode) {
    case 'price':    return sorted.sort((a, b) => a.totalPrice - b.totalPrice);
    case 'duration': return sorted.sort((a, b) => parseDur(a.outboundDuration) - parseDur(b.outboundDuration));
    case 'stops':    return sorted.sort((a, b) => a.totalStops - b.totalStops || a.totalPrice - b.totalPrice);
    case 'best':
    default: return sorted.sort((a, b) => {
      const sA = a.totalPrice + a.totalStops * 300 + parseDur(a.outboundDuration) * 0.5;
      const sB = b.totalPrice + b.totalStops * 300 + parseDur(b.outboundDuration) * 0.5;
      return sA - sB;
    });
  }
}

function assignBadges(offers) {
  if (!offers.length) return offers;
  const out = offers.map(o => ({ ...o, badges: [] }));
  const parseDur = str => {
    if (!str) return 9999;
    const h = str.match(/(\d+)h/); const m = str.match(/(\d+)m/);
    return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
  };

  const minPrice = Math.min(...out.map(o => o.totalPrice));
  const minStops = Math.min(...out.map(o => o.totalStops));
  const minDur   = Math.min(...out.map(o => parseDur(o.outboundDuration)));
  const minScore = Math.min(...out.map(o => o.totalPrice + o.totalStops * 200));

  out.forEach(o => {
    const score = o.totalPrice + o.totalStops * 200;
    if (o.totalPrice === minPrice)               o.badges.push('Lowest Fare');
    if (o.totalStops === 0 && o.totalStops === minStops) o.badges.push('Non-Stop');
    if (score === minScore && !o.badges.includes('Lowest Fare')) o.badges.push('Best Value');
    if (parseDur(o.outboundDuration) === minDur && !o.badges.includes('Non-Stop')) o.badges.push('Fastest');
  });

  return out;
}

module.exports = { normalizeSearchAPIResponse, normalizeSerpapiResponse:normalizeSearchAPIResponse, sortOffers, assignBadges };
