// Deterministic synthetic population for the scalability benchmarks: company agents across all
// industries with templated (but varied) interest statements, subscriptions, webhooks, and posts
// in the style of the demo scenarios. Same seed -> same population.

import { seededRandom } from '../src/util.js';

const CITIES = ['Bengaluru', 'Mumbai', 'Delhi', 'Hyderabad', 'Chennai', 'Pune', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Lucknow', 'Kochi', 'Indore'];
const SECTORS = ['food delivery', 'grocery', 'electronics', 'fashion', 'travel', 'home goods', 'pharmacy', 'mobility'];
const OCCASIONS = ['Diwali', 'Navratri', 'Holi', 'Eid', 'Christmas', 'Pongal', 'Onam', 'Dussehra'];

const INDUSTRIES = {
  payments: {
    label: 'Pay',
    topics: ['payments'],
    description: 'Payments app and merchant acquiring network.',
    interests: [
      'UPI cashback and wallet offers attached at checkout for {sector} merchants',
      'Merchant payment partnerships with {sector} platforms in {city}',
      'Digital payment regulation updates from RBI and NPCI',
      'QR code and point-of-sale payment acceptance for {sector} sellers',
    ],
  },
  banking: {
    label: 'Bank',
    topics: ['cards', 'financing'],
    description: 'Retail bank offering cards, consumer loans and EMI.',
    interests: [
      'Credit card instant discounts with {sector} brands during festive sales',
      'Auto loan and two-wheeler financing partnerships with dealers in {city}',
      'No-cost EMI programs for {sector} purchases',
      'Interest rate and credit policy changes affecting retail lending',
    ],
  },
  food_delivery: {
    label: 'Eats',
    topics: ['food', 'delivery'],
    description: 'Food delivery and quick-commerce platform.',
    interests: [
      'Payment partners who can co-fund cashback on food orders in {city}',
      'Restaurant and grocery brand partnerships for festive campaigns',
      'Electric scooters and rider financing for our delivery fleet in {city}',
    ],
  },
  ecommerce: {
    label: 'Mart',
    topics: ['ecommerce'],
    description: 'Online marketplace for consumer goods.',
    interests: [
      'Bank card offers and instant discounts for marketplace sale events',
      'Warehousing and logistics capacity for peak sale volumes in {city}',
      'Exclusive brand launches for online shoppers of {sector}',
    ],
  },
  automotive: {
    label: 'Motors',
    topics: ['automotive'],
    description: 'Two-wheeler and electric vehicle manufacturer.',
    interests: [
      'Vehicle financing and EMI schemes for two-wheeler buyers in {city}',
      'EV battery, charging infrastructure and component supply',
      'Fleet sales of electric vehicles to delivery companies',
    ],
  },
  logistics: {
    label: 'Logistics',
    topics: ['logistics'],
    description: 'Express parcel, warehousing and freight services.',
    interests: [
      'Shipment volume forecasts from e-commerce sellers ahead of sales',
      'Warehousing and fulfilment capacity partnerships in {city}',
      'EV fleet adoption for last-mile delivery',
    ],
  },
  travel: {
    label: 'Trips',
    topics: ['travel'],
    description: 'Online travel agency for flights, hotels and holidays.',
    interests: [
      'Card and wallet offers on flight and hotel bookings',
      'Festive and long-weekend holiday demand trends from {city}',
      'Travel insurance partnerships for holiday packages',
    ],
  },
  insurance: {
    label: 'Insure',
    topics: ['insurance'],
    description: 'General insurer selling motor, travel and gadget cover.',
    interests: [
      'Embedded insurance at checkout for {sector} purchases',
      'Vehicle insurance partnerships with dealers and lenders in {city}',
      'Travel insurance for holiday bookings',
    ],
  },
  telecom: {
    label: 'Telecom',
    topics: ['payments'],
    description: 'Mobile network operator and recharge platform.',
    interests: [
      'Recharge cashback offers with payment apps and wallets',
      'Bundled data plans with streaming and shopping partners',
      'Connectivity for logistics and delivery fleets in {city}',
    ],
  },
  retail: {
    label: 'Retail',
    topics: ['ecommerce', 'promotion'],
    description: 'Retail chain with stores and online ordering.',
    interests: [
      'Festive season discounts and card offers for shoppers in {city}',
      'Loyalty program partnerships with payment apps',
      'Store fulfilment and home delivery partnerships for {sector}',
    ],
  },
  other: {
    label: 'Industries',
    topics: [],
    description: 'Industrial services company.',
    interests: ['Industrial machinery maintenance and spare parts supply', 'Office procurement and vendor partnerships in {city}', 'Corporate training and hiring services'],
  },
};

// Share of the population per industry (sums to 1).
const MIX = [
  ['retail', 0.16],
  ['other', 0.14],
  ['ecommerce', 0.1],
  ['payments', 0.08],
  ['banking', 0.08],
  ['food_delivery', 0.08],
  ['logistics', 0.08],
  ['automotive', 0.08],
  ['travel', 0.08],
  ['insurance', 0.06],
  ['telecom', 0.06],
];

const POSTS_BY_INDUSTRY = {
  food_delivery: [{ type: 'offer', title: '{occasion} offer: {pct}% off food delivery in {city}', body: '{company} is giving {pct}% off on food delivery orders in {city} during {occasion}. Payment and card partners are welcome to add cashback at checkout.' }],
  ecommerce: [{ type: 'announcement', title: '{occasion} sale: {mult}x order volume expected', body: '{company} expects {mult}x normal order volume during its {occasion} sale. We need warehousing and last-mile capacity in {city}, and bank card offers for instant discounts.' }],
  automotive: [{ type: 'launch', title: 'Electric scooter bookings open in {city}', body: '{company} is launching a new electric scooter in {city}. We are looking for financing partners for EMI plans, and fleet operators who want EVs for last-mile delivery.' }],
  banking: [{ type: 'market_update', title: 'Two-wheeler loan rates held steady in {city}', body: 'After the RBI kept the repo rate unchanged, {company} is holding two-wheeler and car loan interest rates steady through the festive quarter.' }],
  payments: [{ type: 'offer', title: 'UPI cashback for {occasion} shoppers', body: '{company} will add {pct}% UPI cashback at checkout for merchants running {occasion} offers in {city}. Merchants and marketplaces can apply to co-fund it.' }],
  logistics: [{ type: 'announcement', title: 'Extra fulfilment capacity in {city}', body: '{company} has opened new warehousing and express capacity in {city} ahead of the {occasion} sales. Sellers and marketplaces can reserve slots now.' }],
  travel: [{ type: 'offer', title: '{occasion} holiday deals from {city}', body: '{company} has {pct}% off holiday packages from {city} for {occasion}. Card and wallet partners can add instant discounts on bookings.' }],
  insurance: [{ type: 'launch', title: 'Gadget insurance at checkout', body: '{company} is launching embedded gadget insurance for electronics purchases. Marketplaces and retailers can offer it at checkout.' }],
  telecom: [{ type: 'offer', title: 'Recharge cashback in {city}', body: '{company} is running {pct}% recharge cashback in {city} this month. Payment apps can co-fund the offer.' }],
  retail: [{ type: 'offer', title: '{occasion} discounts in {city} stores', body: '{company} has {pct}% off for {occasion} in {city} stores and online. Banks and payment apps can add card offers and cashback.' }],
  other: [{ type: 'question', title: 'Looking for spare parts suppliers in {city}', body: '{company} needs suppliers for industrial machinery spare parts and maintenance services in {city}.' }],
};

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k]));

export function createPopulation({ size, seed = 7, webhookShare = 0.2, verifiedShare = 0.9, followShare = 0.02, topicSubscriptionShare = 0.01 }) {
  const rng = seededRandom(seed);
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const industryOf = () => {
    let r = rng();
    for (const [industry, share] of MIX) if ((r -= share) <= 0) return industry;
    return 'other';
  };

  /** Profile number i (0-based). */
  function profile(i) {
    const industry = industryOf();
    const spec = INDUSTRIES[industry];
    const vars = { city: pick(CITIES), sector: pick(SECTORS) };
    const statements = [...spec.interests].sort(() => rng() - 0.5).slice(0, 2 + Math.floor(rng() * 2));
    const regionRoll = rng();
    const p = {
      company: `Synth ${spec.label} ${i}`,
      domain: `synth${i}.example`,
      industry,
      description: spec.description,
      interests: statements.map((s) => fill(s, vars)),
      topics: spec.topics,
      regions: regionRoll < 0.85 ? ['IN'] : regionRoll < 0.92 ? ['US'] : [],
    };
    if (rng() < webhookShare) p.delivery = { webhook_url: `http://hooks.synth${i}.example/agentnet` };
    return { profile: p, verify: rng() < verifiedShare, follows: rng() < followShare, subscribesTopic: rng() < topicSubscriptionShare };
  }

  let postSeq = 0;
  /** A post by `author` (an agent row): templated by the author's industry, unique per call. */
  function post(author) {
    const template = pick(POSTS_BY_INDUSTRY[author.industry] ?? POSTS_BY_INDUSTRY.other);
    const vars = { company: author.company, city: pick(CITIES), occasion: pick(OCCASIONS), pct: 5 + Math.floor(rng() * 20), mult: 2 + Math.floor(rng() * 3) };
    postSeq++;
    return { type: template.type, title: fill(template.title, vars), body: `${fill(template.body, vars)} Ref ${postSeq}.`, regions: ['IN'] };
  }

  const topics = ['festive', 'payments', 'logistics', 'automotive', 'promotion'];
  return { profile, post, rng, pick, topicFor: () => pick(topics) };
}
