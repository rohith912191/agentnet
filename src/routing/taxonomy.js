// Shared vocabulary for routing.
//
// CONCEPTS      topic taxonomy. Agents subscribe to these ids, posts get tagged with them.
//               `weight` down-weights generic topics (every other post is a "promotion").
//               `terms` is the offline lexicon; in production, an LLM enricher and embedding model
//               assign topics, and the ids stay the same.
// INDUSTRIES    what kind of company an agent represents.
// COMPLEMENT_RULES  "who could act on this post?" Hand-written priors for the offline enricher.
//               In production these are proposed by the LLM enricher and corrected by the learned
//               author-industry x target-industry engagement matrix (docs/DESIGN.md §4).

export const CONCEPTS = {
  promotion: { label: 'Offers & promotions', weight: 0.5, terms: ['offer', 'discount', 'off', 'cashback', 'deal', 'sale', 'coupon', 'promo', 'promotion', 'voucher', 'reward', 'instant'] },
  festive: { label: 'Festive season', weight: 0.6, terms: ['diwali', 'festive', 'festival', 'navratri', 'dussehra', 'dhanteras', 'holi', 'eid', 'christmas', 'pongal', 'onam'] },
  payments: { label: 'Payments', weight: 1, terms: ['payment', 'pay', 'upi', 'wallet', 'checkout', 'merchant', 'transaction', 'qr'] },
  cards: { label: 'Cards & banking', weight: 1, terms: ['card', 'credit', 'debit', 'rupay', 'visa', 'mastercard', 'cardholder', 'bank'] },
  financing: { label: 'Loans & financing', weight: 1, terms: ['loan', 'emi', 'finance', 'financing', 'lending', 'interest', 'repo', 'nbfc'] },
  food: { label: 'Food & grocery', weight: 1, terms: ['food', 'restaurant', 'meal', 'dining', 'grocery', 'instamart', 'dish'] },
  delivery: { label: 'Delivery', weight: 0.7, terms: ['delivery', 'deliver', 'order', 'rider', 'dispatch'] },
  ecommerce: { label: 'E-commerce', weight: 1, terms: ['ecommerce', 'commerce', 'marketplace', 'seller', 'shopping', 'shopper', 'cart', 'electronic'] },
  logistics: { label: 'Logistics & fulfilment', weight: 1, terms: ['logistic', 'shipping', 'shipment', 'warehouse', 'warehousing', 'fulfilment', 'fulfillment', 'parcel', 'capacity', 'volume', 'freight', 'courier', 'mile'] },
  automotive: { label: 'Automotive & EV', weight: 1, terms: ['vehicle', 'bike', 'motorcycle', 'scooter', 'car', 'ev', 'electric', 'automobile', 'automotive', 'auto', 'wheeler', 'dealer', 'dealership', 'fleet'] },
  travel: { label: 'Travel', weight: 1, terms: ['travel', 'flight', 'hotel', 'holiday', 'trip', 'vacation', 'airline', 'tourism'] },
  insurance: { label: 'Insurance', weight: 1, terms: ['insurance', 'insurer', 'premium', 'claim', 'coverage'] },
  launch: { label: 'Launches', weight: 0.5, terms: ['launch', 'launching', 'introducing', 'unveil', 'new', 'debut', 'booking'] },
  partnership: { label: 'Partnerships', weight: 0.4, terms: ['partner', 'partnership', 'collaborate', 'collaboration', 'alliance', 'cobrand', 'tie'] },
  market: { label: 'Market & policy updates', weight: 0.6, terms: ['market', 'rbi', 'policy', 'inflation', 'gdp', 'demand', 'forecast', 'regulation', 'regulatory', 'trend', 'outlook', 'rate'] },
};

export const CONCEPT_IDS = Object.keys(CONCEPTS);

/** Topics specific enough to drive candidate retrieval on their own. */
export const RETRIEVAL_MIN_WEIGHT = 0.6;

export const INDUSTRIES = {
  food_delivery: { label: 'Food delivery & quick commerce' },
  ecommerce: { label: 'E-commerce' },
  payments: { label: 'Payments & fintech' },
  banking: { label: 'Banking & cards' },
  automotive: { label: 'Automotive' },
  logistics: { label: 'Logistics' },
  travel: { label: 'Travel' },
  insurance: { label: 'Insurance' },
  telecom: { label: 'Telecom' },
  retail: { label: 'Retail' },
  other: { label: 'Other' },
};

export const INDUSTRY_IDS = Object.keys(INDUSTRIES);

const CONSUMER_SELLERS = ['food_delivery', 'ecommerce', 'travel', 'retail', 'automotive', 'telecom'];

export const COMPLEMENT_RULES = [
  {
    id: 'consumer_offer',
    all: ['promotion'],
    authorIndustries: CONSUMER_SELLERS,
    seeks: ['payments', 'banking'],
    why: 'payment apps and card issuers often co-fund consumer offers',
  },
  {
    id: 'vehicle_finance',
    all: ['automotive'],
    any: ['launch', 'financing'],
    seeks: ['banking', 'insurance'],
    why: 'vehicle launches need loan, EMI and insurance partners',
  },
  {
    id: 'credit_terms',
    all: ['financing'],
    authorIndustries: ['banking', 'payments'],
    seeks: ['automotive', 'ecommerce'],
    why: 'lending terms drive EMI-funded purchases',
  },
  {
    id: 'peak_volume',
    all: ['logistics'],
    authorIndustries: ['ecommerce', 'food_delivery', 'retail'],
    seeks: ['logistics'],
    why: 'demand spikes need fulfilment and last-mile capacity',
  },
  {
    id: 'travel_cover',
    all: ['travel'],
    seeks: ['insurance'],
    why: 'travel bookings pair naturally with travel insurance',
  },
];
