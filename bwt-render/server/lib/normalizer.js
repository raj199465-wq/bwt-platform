/**
 * Normalizes raw Amadeus Flight Offers Search response
 * into BWT's internal NormalizedOffer schema
 */

const CABIN_RANK = { FIRST: 4, BUSINESS: 3, PREMIUM_ECONOMY: 2, ECONOMY: 1 };

/**
 * @param {object} raw  - full Amadeus /v2/shopping/flight-offers response
 * @param {string} requestedCabin - 'BUSINESS' | 'FIRST' | 'PREMIUM_ECONOMY' | 'ECONOMY'
 * @returns {NormalizedOffer[]}
 */
function normalizeOffers(raw, requestedCabin = 'BUSINESS') {
  const { data = [], dictionaries = {} } = raw;
  const { carriers = {}, aircraft = {}, currencies = {}, locations = {} } = dictionaries;

  return data
    .map(offer => normalizeOffer(offer, { carriers, aircraft, currencies, locations }, requestedCabin))
    .filter(Boolean)
    .sort((a, b) => a.totalPrice - b.totalPrice);
}

function normalizeOffer(offer, dicts, requestedCabin) {
  try {
    const { id, source, instantTicketingRequired, nonHomogeneous,
            oneWay, lastTicketingDate, numberOfBookableSeats,
            itineraries = [], price = {}, pricingOptions = {},
            validatingAirlineCodes = [], travelerPricings = [] } = offer;

    const totalPrice  = parseFloat(price.grandTotal || price.total || 0);
    const currency    = price.currency || 'USD';
    const basePrice   = parseFloat(price.base || 0);
    const taxes       = totalPrice - basePrice;
    const perPax      = parseFloat(price.perAdult?.total || totalPrice);

    // Itineraries → journeys
    const journeys = itineraries.map((itin, idx) =>
      normalizeItinerary(itin, idx, dicts, offer, travelerPricings)
    );

    // Baggage from first traveler pricing
    const baggageSummary = extractBaggage(travelerPricings);

    // Fare conditions
    const fareConditions = extractFareConditions(travelerPricings);

    // Cabin detection
    const detectedCabin = detectCabin(travelerPricings);

    // Validating carrier
    const validatingCarrier = validatingAirlineCodes[0] || journeys[0]?.segments[0]?.carrier?.code || '';
    const carrierName = dicts.carriers[validatingCarrier] || validatingCarrier;

    // Stops summary
    const totalStops = journeys.reduce((sum, j) => sum + (j.segments.length - 1), 0);

    // Duration (first outbound journey)
    const outboundDuration = journeys[0]?.duration || '';

    return {
      id,
      source,
      totalPrice,
      perPaxPrice: perPax,
      basePrice,
      taxes,
      currency,
      cabin: detectedCabin,
      requestedCabin,
      cabinMatch: detectedCabin === requestedCabin,
      validatingCarrier,
      carrierName,
      journeys,
      totalStops,
      outboundDuration,
      baggageSummary,
      fareConditions,
      seatsAvailable: numberOfBookableSeats || null,
      lastTicketingDate: lastTicketingDate || null,
      instantTicketing: instantTicketingRequired || false,
      refundable: fareConditions.refundable,
      changeable: fareConditions.changeable,
      // Keep raw for repricing
      _raw: offer,
    };
  } catch (e) {
    console.error('[normalizeOffer] error:', e.message, offer?.id);
    return null;
  }
}

function normalizeItinerary(itin, idx, dicts, offer, travelerPricings) {
  const { duration, segments = [] } = itin;

  const normalizedSegments = segments.map(seg =>
    normalizeSegment(seg, dicts, offer, travelerPricings, idx)
  );

  const dep = normalizedSegments[0]?.departure;
  const arr = normalizedSegments[normalizedSegments.length - 1]?.arrival;

  return {
    index: idx,
    direction: idx === 0 ? 'outbound' : 'return',
    duration: formatDuration(duration),
    durationRaw: duration,
    origin:      dep?.airport || '',
    destination: arr?.airport || '',
    originCity:  dep?.city || dep?.airport || '',
    destCity:    arr?.city || arr?.airport || '',
    depTime:     dep?.datetime || '',
    arrTime:     arr?.datetime || '',
    stops:       segments.length - 1,
    segments:    normalizedSegments,
  };
}

function normalizeSegment(seg, dicts, offer, travelerPricings, itnIdx) {
  const { departure, arrival, carrierCode, number, aircraft,
          operating, duration, numberOfStops, blacklistedInEU } = seg;

  const airlineName = dicts.carriers[carrierCode] || carrierCode;
  const opCode = operating?.carrierCode || carrierCode;
  const opName = dicts.carriers[opCode] || opCode;
  const acModel = dicts.aircraft[aircraft?.code] || aircraft?.code || '';

  // Cabin for this segment from traveler pricing
  const segCabin = getSegmentCabin(travelerPricings, itnIdx, seg.id);

  return {
    id: seg.id,
    flightNumber: `${carrierCode}${number}`,
    carrier: { code: carrierCode, name: airlineName },
    operating: opCode !== carrierCode ? { code: opCode, name: opName } : null,
    aircraft: acModel,
    departure: {
      airport:  departure.iataCode,
      terminal: departure.terminal || null,
      datetime: departure.at,
      city:     dicts.locations?.[departure.iataCode]?.cityCode || departure.iataCode,
    },
    arrival: {
      airport:  arrival.iataCode,
      terminal: arrival.terminal || null,
      datetime: arrival.at,
      city:     dicts.locations?.[arrival.iataCode]?.cityCode || arrival.iataCode,
    },
    duration:    formatDuration(duration),
    durationRaw: duration,
    stops:       numberOfStops || 0,
    cabin:       segCabin,
    blacklisted: blacklistedInEU || false,
  };
}

function getSegmentCabin(travelerPricings, itnIdx, segId) {
  try {
    const tp = travelerPricings[0];
    const itn = tp?.fareDetailsBySegment || [];
    // match by segment sequence
    const fd = itn.find(f => f.segmentId === segId);
    return fd?.cabin || 'BUSINESS';
  } catch { return 'BUSINESS'; }
}

function detectCabin(travelerPricings) {
  try {
    const cabins = travelerPricings[0]?.fareDetailsBySegment?.map(f => f.cabin) || [];
    if (!cabins.length) return 'BUSINESS';
    // Return highest cabin found
    return cabins.reduce((best, c) =>
      (CABIN_RANK[c] || 0) > (CABIN_RANK[best] || 0) ? c : best
    , cabins[0]);
  } catch { return 'BUSINESS'; }
}

function extractBaggage(travelerPricings) {
  try {
    const tp = travelerPricings[0];
    const fds = tp?.fareDetailsBySegment || [];
    const bags = fds.map(fd => {
      const included = fd.includedCheckedBags;
      if (!included) return null;
      if (included.quantity) return `${included.quantity} bag${included.quantity > 1 ? 's' : ''} included`;
      if (included.weight) return `${included.weight}${included.weightUnit || 'kg'} included`;
      return 'Baggage included';
    }).filter(Boolean);

    return {
      summary:  bags[0] || 'Check airline policy',
      perSegment: bags,
      included: bags.length > 0,
    };
  } catch {
    return { summary: 'Check airline policy', perSegment: [], included: false };
  }
}

function extractFareConditions(travelerPricings) {
  try {
    const amenities = travelerPricings[0]?.fareDetailsBySegment?.[0]?.amenities || [];
    let refundable = null;
    let changeable = null;

    amenities.forEach(a => {
      const desc = (a.description || '').toUpperCase();
      if (desc.includes('REFUND')) refundable = !a.isChargeable;
      if (desc.includes('CHANGE') || desc.includes('EXCHANGE')) changeable = !a.isChargeable;
    });

    return {
      refundable,
      changeable,
      fareFamily: travelerPricings[0]?.fareDetailsBySegment?.[0]?.brandedFare || null,
      fareBasis:  travelerPricings[0]?.fareDetailsBySegment?.[0]?.fareBasis  || null,
      amenities: amenities.map(a => ({
        description: a.description,
        isChargeable: a.isChargeable,
        amenityType: a.amenityType,
      })),
    };
  } catch {
    return { refundable: null, changeable: null, fareFamily: null, fareBasis: null, amenities: [] };
  }
}

function formatDuration(iso) {
  if (!iso) return '';
  const h = iso.match(/(\d+)H/);
  const m = iso.match(/(\d+)M/);
  const hours   = h ? parseInt(h[1]) : 0;
  const minutes = m ? parseInt(m[1]) : 0;
  if (!hours && !minutes) return iso;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/**
 * Sort modes
 */
function sortOffers(offers, mode = 'price') {
  const sorted = [...offers];
  switch (mode) {
    case 'price':
      return sorted.sort((a, b) => a.totalPrice - b.totalPrice);
    case 'duration':
      return sorted.sort((a, b) =>
        (parseDuration(a.outboundDuration) - parseDuration(b.outboundDuration))
      );
    case 'stops':
      return sorted.sort((a, b) => a.totalStops - b.totalStops || a.totalPrice - b.totalPrice);
    case 'best':
      // Balance of price + stops + duration
      return sorted.sort((a, b) => {
        const scoreA = a.totalPrice + a.totalStops * 300 + parseDuration(a.outboundDuration) * 0.5;
        const scoreB = b.totalPrice + b.totalStops * 300 + parseDuration(b.outboundDuration) * 0.5;
        return scoreA - scoreB;
      });
    default:
      return sorted;
  }
}

function parseDuration(str) {
  if (!str) return 9999;
  const h = str.match(/(\d+)h/);
  const m = str.match(/(\d+)m/);
  return (h ? parseInt(h[1]) * 60 : 0) + (m ? parseInt(m[1]) : 0);
}

/**
 * Badge assignment
 */
function assignBadges(offers) {
  if (!offers.length) return offers;
  const withBadges = offers.map(o => ({ ...o, badges: [] }));

  // Cheapest
  const minPrice = Math.min(...withBadges.map(o => o.totalPrice));
  withBadges.forEach(o => {
    if (o.totalPrice === minPrice) o.badges.push('Lowest Fare');
  });

  // Fewest stops
  const minStops = Math.min(...withBadges.map(o => o.totalStops));
  withBadges.filter(o => o.totalStops === minStops && o.totalStops === 0)
    .slice(0, 1).forEach(o => o.badges.push('Non-Stop'));

  // Best value (score)
  const scored = withBadges.map(o => ({
    ...o,
    _score: o.totalPrice + o.totalStops * 200,
  }));
  const minScore = Math.min(...scored.map(o => o._score));
  scored.filter(o => o._score === minScore).slice(0, 1)
    .forEach(o => o.badges.push('Best Value'));

  // Fastest
  const minDur = Math.min(...withBadges.map(o => parseDuration(o.outboundDuration)));
  withBadges.filter(o => parseDuration(o.outboundDuration) === minDur)
    .slice(0, 1).forEach(o => {
      if (!o.badges.includes('Non-Stop')) o.badges.push('Fastest');
    });

  return scored.map(({ _score, ...o }) => o);
}

module.exports = { normalizeOffers, sortOffers, assignBadges, formatDuration };
