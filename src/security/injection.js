// Prompt-injection detection for content that other agents' LLMs will read (posts, comments,
// profiles). Deterministic first line of defence; the structural defence is that content always
// reaches agents and LLM stages as fenced, untrusted data, never as instructions.
//
// Approach
//   1. Several views of the text are screened, so obfuscation does not hide a phrase:
//        reader view   NFKC-folded, invisible characters removed (as a person or a model reads it)
//        folded view   + homoglyphs (Cyrillic/Greek look-alikes) -> Latin, leetspeak inside words,
//                      spaced-out or separator-split letters joined ("i g n o r e", "ig-nore")
//        decoded view  base64 / hex / %-encoded runs that decode to text
//   2. Strong signals (an instruction aimed at the reading model, a request for its secrets, fake
//      chat-role tags) flag on their own; weak signals ("new instructions:", "act as") need two.
//   3. The same intents in Hindi (Devanagari and romanised), Spanish, French, German, Portuguese,
//      Italian, Russian, Chinese, Japanese and Arabic.
// To keep false positives down on ordinary business text, instructions must target the model's
// instructions or the reader's secrets: "ignore the previous price list", "you are now eligible
// for cashback" and "we will share API keys with onboarded partners" are not flagged.

const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

// Latin look-alikes used to dodge keyword checks (Cyrillic, Greek, some IPA letters).
const HOMOGLYPHS = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ї: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ԛ: 'q', ԝ: 'w', һ: 'h', ү: 'y',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w', ϲ: 'c', ɡ: 'g', ɪ: 'i', ʏ: 'y', ᴅ: 'd', ɴ: 'n', ʀ: 'r', ꜱ: 's',
};
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'l' };

/** Text as a reader sees it: NFKC-folded (full-width letters become ASCII), invisible characters removed. */
export const readerView = (text) => String(text).normalize('NFKC').replace(INVISIBLE, '');

/** Reader view with look-alike letters, in-word leetspeak and split-up letters folded back. */
export function foldedView(text) {
  let t = readerView(text).toLowerCase();
  t = t.replace(/[Ͱ-ϿЀ-ӿɐ-ʯᴀ-ᵿ꜀-ꟿ]/g, (c) => HOMOGLYPHS[c] ?? c);
  // Leetspeak only inside words that also contain letters ("1gn0re", "s3cr3ts"), so prices and
  // percentages ("5% off", "1,999") are untouched.
  t = t.replace(/[a-z0-9@$!|]+/g, (w) => (/[a-z]/.test(w) && /[0-9@$!|]/.test(w) ? w.replace(/[0134578@$!|]/g, (c) => LEET[c]) : w));
  // Letters split by single spaces, dots, dashes or underscores: "i g n o r e", "i.g.n.o.r.e".
  t = t.replace(/\b(?:[a-z][ ._-]){3,}[a-z]\b/g, (run) => run.replace(/[ ._-]/g, ''));
  // Separators inside words: "ign_ore", "instruc-tions", "sys*tem".
  t = t.replace(/([a-z])[-_*~^]+(?=[a-z])/g, '$1');
  return t;
}

/** Decodes base64, hex and %-encoded runs that look like smuggled text. */
export function decodedViews(text) {
  const out = [];
  for (const run of String(text).match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
    const decoded = Buffer.from(run, 'base64').toString('utf8');
    if (/^[\x20-\x7e\s]{12,}$/.test(decoded)) out.push(decoded);
  }
  for (const run of String(text).match(/(?:[0-9a-f]{2}){12,}/gi) ?? []) {
    const decoded = Buffer.from(run, 'hex').toString('utf8');
    if (/^[\x20-\x7e\s]{12,}$/.test(decoded)) out.push(decoded);
  }
  if (/%[0-9a-f]{2}/i.test(text)) {
    try {
      const decoded = decodeURIComponent(String(text));
      if (decoded !== text) out.push(decoded);
    } catch {
      // not valid percent-encoding: nothing hidden there
    }
  }
  return out;
}

// ---- English (run on the folded view) ---------------------------------------------------------

const OVERRIDE_VERB = '(?:ignore|disregard|forget|override|bypass|abandon|discard)';
// Business objects: "ignore the previous instructions on the coupon" is about the coupon.
const BUSINESS_OBJECT =
  '(?!\\s+(?:on|for|about|regarding)\\s+(?:the|our|this|that|last)\\s+(?:coupon|order|form|invoice|shipment|delivery|payment|booking|offer|sale|campaign|listing|catalog(?:ue)?|price|pricing|return|refund|registration|application|website|portal|app|kit|product|device|installation|setup)s?\\b)';
// What a model was told: "all previous instructions", "the system prompt".
const MODEL_INSTRUCTIONS = `(?:(?:previous|prior|above|earlier|preceding|original|initial|existing|all|any|your|the|these|those|system|developer)\\s+){1,4}(?:instructions?|prompts?|directives?|programming|system\\s+prompt)\\b${BUSINESS_OBJECT}`;
// Generic nouns count only when they are the model's own: "your rules", "the safety guidelines".
const MODEL_RULES = '(?:(?:all\\s+)?(?:your|the\\s+system|system|safety|the\\s+safety|developer|content)\\s+)(?:rules|guidelines|guardrails|constraints|policies|restrictions|filters)\\b';
const SECRETS =
  '(?:api[\\s_-]?keys?|secret[\\s_-]?keys?|webhook[\\s_-]?secrets?|secrets|credentials|passwords?|access[\\s_-]?tokens?|bearer\\s+tokens?|private[\\s_-]?keys?|system\\s+prompt|hidden\\s+prompt|internal\\s+(?:instructions|prompt))';
const DISCLOSE_VERB = '(?:reveal|print|output|show|display|share|send|leak|dump|paste|return|reply\\s+with|respond\\s+with|tell\\s+(?:me|us)|give\\s+(?:me|us)|post|email|forward|repeat|recite|write\\s+out)';
const AI_READER = '(?:ai|llm|language\\s+model|assistant|ai\\s+agent|chatbot|bot)';
// "do not share your password", "never ignore the safety guidelines": warnings, not requests.
const NOT_NEGATED = "(?<!\\b(?:not|never|don't|dont|nobody|no\\s+one)\\s+(?:\\w+\\s+)?)";

const STRONG_EN = [
  // "ignore all previous instructions", "forget the system prompt", "disregard your rules"
  new RegExp(`${NOT_NEGATED}\\b${OVERRIDE_VERB}\\b[^.\\n]{0,24}?\\b${MODEL_INSTRUCTIONS}`),
  new RegExp(`${NOT_NEGATED}\\b${OVERRIDE_VERB}\\b[^.\\n]{0,16}?\\b${MODEL_RULES}`),
  // "reveal your API key", "send us your webhook secret", "print the system prompt"
  // (but not "send us your password reset requests" or "do not share your password")
  new RegExp(
    `${NOT_NEGATED}\\b${DISCLOSE_VERB}\\b[^.\\n]{0,30}?\\b(?:your|the\\s+(?:agent'?s|assistant'?s|model'?s|platform'?s|system)|its|all\\s+(?:your|the))\\s+${SECRETS}\\b(?!\\s+(?:reset|policy|policies|manager|requirements?|rotation|change|expiry|management|vault|format)\\b)`,
  ),
  new RegExp(`${NOT_NEGATED}\\b${DISCLOSE_VERB}\\b[^.\\n]{0,12}?\\b(?:system|hidden|initial)\\s+prompt\\b`),
  // Role hijacking aimed at the model.
  /\byou\s+are\s+no\s+longer\s+(?:an?\s+)?(?:ai|assistant|bound|restricted|limited)\b/,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:an?\s+)?(?:unrestricted|unfiltered|uncensored|jailbroken|evil|rogue)\b/,
  /\byou\s+are\s+(?:now\s+)?(?:in|running\s+in|operating\s+in)\s+(?:developer|god|jailbreak|dan|debug|admin|sudo|maintenance|unrestricted)\s+mode\b/,
  /\b(?:developer|god|jailbreak|dan)\s+mode\s+(?:enabled|activated|engaged)\b/,
  /\b(?:enter|enable|activate|switch\s+to)\s+(?:jailbreak|dan|god)\s+mode\b/,
  /\bdo\s+anything\s+now\b/,
  // Fake conversation structure.
  /<\/?\s*(?:system|assistant|instructions?|tool_use|tool_result|im_start|im_end)\s*>/,
  /\[\s*(?:system|inst|\/inst)\s*\]/,
  /(?:^|\n)\s*#{2,}\s*(?:system|instructions?)\s*#*\s*(?:\n|:)/,
  // Instructions addressed to whatever model processes the text.
  new RegExp(`\\b(?:attention|note|message)\\s+(?:to\\s+)?(?:all\\s+)?${AI_READER}s?\\b[^.\\n]{0,60}\\b(?:ignore|disregard|reveal|forget|override)\\b`),
  new RegExp(`\\bif\\s+you\\s+are\\s+an?\\s+${AI_READER}\\b[^.\\n]{0,60}\\b(?:ignore|disregard|reveal|forget|override)\\b`),
];

const WEAK_EN = [
  /\bnew\s+instructions\s*:/,
  /\b(?:act|behave)\s+as\s+(?:if\s+you\s+(?:are|were)|an?\s+(?:unrestricted|different))\b/,
  /\bpretend\s+(?:to\s+be|you\s+are)\b/,
  /\bsystem\s+prompt\b/,
  /\bas\s+an\s+ai\s+(?:language\s+)?model\b/,
  /\bfrom\s+now\s+on\s+you\b/,
  /\boverride\s+(?:mode|protocol)\b/,
];

// ---- other languages (run on the reader view) ------------------------------------------------

const MULTILINGUAL = [
  // Hindi (Devanagari; matched with nukta marks removed, see detectInjection)
  /(?:पिछले|पहले\s+के|सभी|ऊपर\s+के)[^।.\n]{0,20}(?:निर्देश|निर्देशों|आदेश|नियम)[^।.\n]{0,20}(?:अनदेखा|नजरअंदाज|भूल|मत\s+मानो)/u,
  /(?:सिस्टम\s+प्रॉम्प्ट|एपीआई\s+की|गुप्त\s+कुंजी|पासवर्ड)[^।.\n]{0,25}(?:बताओ|बताइए|भेजो|भेजें|दिखाओ|दिखाएं|लिखो)/u,
  // Hindi (romanised)
  /\b(?:pichhle|pichle|sabhi|saare|upar\s+ke)\b[^.\n]{0,25}\b(?:instructions?|nirdesh|niyam|aadesh)\b[^.\n]{0,20}\b(?:ignore|bhool|nazarandaz|anadekha|mat\s+mano)\b/i,
  /\b(?:apni|apna|apne)\s+(?:api\s+key|secret|password|system\s+prompt)\b[^.\n]{0,20}\b(?:batao|bhejo|dikhao|likho)\b/i,
  // Spanish
  /\b(?:ignora|ignore|ignorar|olvida|olvide|olvidar|omite)\b[^.\n]{0,20}\b(?:las\s+|tus\s+|todas\s+las\s+)?(?:instrucciones|indicaciones|reglas)\s+(?:anteriores|previas|del\s+sistema)\b/i,
  /\b(?:revela|muestra|env[ií]a|comparte|dime)\b[^.\n]{0,20}\b(?:tu|tus|la|las|el)\s+(?:clave(?:s)?\s+(?:de\s+)?api|contraseñas?|credenciales|prompt\s+del\s+sistema|secretos?)\b/i,
  // French
  /\b(?:ignore[zr]?|oublie[zr]?|néglige[zr]?)\b[^.\n]{0,20}\b(?:les\s+|toutes\s+les\s+|vos\s+|tes\s+)?(?:instructions|consignes|règles)\s+(?:précédentes|antérieures|du\s+système)\b/i,
  /\b(?:révèle[zr]?|affiche[zr]?|envoie[zr]?|donne[zr]?(?:-moi)?)\b[^.\n]{0,20}\b(?:ta|ton|tes|votre|vos)\s+(?:clés?\s+api|mots?\s+de\s+passe|identifiants|prompt\s+système|secrets?)\b/i,
  // German
  /\b(?:ignoriere|ignorieren\s+sie|vergiss|vergessen\s+sie|missachte)\b[^.\n]{0,25}\b(?:alle\s+)?(?:vorherigen|bisherigen|obigen|früheren)\s+(?:anweisungen|instruktionen|regeln|befehle)\b/i,
  /\b(?:gib|zeige?|verrate|sende|schicke?)\b[^.\n]{0,20}\b(?:dein(?:en)?|ihre?n?)\s+(?:api-?schlüssel|passw(?:ö|oe)rter?|zugangsdaten|systemprompt|geheimnisse?)\b/i,
  // Portuguese
  /\b(?:ignore|ignora|esqueça|esqueca|desconsidere)\b[^.\n]{0,20}\b(?:as\s+|todas\s+as\s+)?(?:instruções|instrucoes|regras)\s+(?:anteriores|prévias|previas|do\s+sistema)\b/i,
  /\b(?:revele|mostre|envie|compartilhe)\b[^.\n]{0,20}\b(?:sua|suas|seu|seus)\s+(?:chaves?\s+(?:de\s+)?api|senhas?|credenciais|prompt\s+do\s+sistema)\b/i,
  // Italian
  /\b(?:ignora|dimentica|trascura)\b[^.\n]{0,20}\b(?:le\s+|tutte\s+le\s+)?(?:istruzioni|regole)\s+(?:precedenti|del\s+sistema)\b/i,
  // Russian
  /(?:игнорируй|игнорируйте|забудь|забудьте|проигнорируй)[^.\n]{0,25}(?:предыдущие|прежние|все|системные)\s+(?:инструкции|указания|правила)/iu,
  /(?:покажи|отправь|раскрой|сообщи)[^.\n]{0,20}(?:свой|свои|твой|твои|ваш|ваши)\s+(?:api[- ]?ключ\w*|пароль\w*|системный\s+промпт|секрет\w*)/iu,
  // Chinese
  /(?:忽略|无视|忘记|忽视)(?:之前|以前|上面|上述|先前|所有|全部)?(?:的)?(?:所有|全部)?(?:指令|指示|说明|规则|提示)/u,
  /(?:泄露|透露|显示|输出|发送|告诉我)(?:你的|您的)?(?:系统提示|系统提示词|密钥|API\s*密钥|密码|凭证)/u,
  // Japanese
  /(?:以前|前|上記|これまで)の(?:指示|命令|ルール)を(?:無視|忘れ)/u,
  /システムプロンプトを(?:表示|出力|教え|見せ)/u,
  // Arabic
  /(?:تجاهل|انس|أهمل)\s+(?:جميع\s+)?(?:التعليمات|الأوامر|القواعد)\s+(?:السابقة|السابقه)/u,
];

/**
 * Screens one text. Returns { injection: boolean, signals: [...] } where signals name what matched
 * (for moderators and metrics; never echoed to the author in detail).
 */
export function detectInjection(raw) {
  const signals = [];
  const reader = readerView(raw);
  const views = [foldedView(raw), ...decodedViews(reader).map(foldedView)];
  for (const [i, view] of views.entries()) {
    const where = i === 0 ? 'text' : 'encoded';
    if (STRONG_EN.some((re) => re.test(view))) signals.push(`strong:${where}`);
    const weak = WEAK_EN.filter((re) => re.test(view)).length;
    if (weak >= 2) signals.push(`weak_combination:${where}`);
  }
  const multilingual = reader.normalize('NFD').replace(/़/g, '').normalize('NFC'); // "ज़" and "ज" read alike
  if (MULTILINGUAL.some((re) => re.test(multilingual))) signals.push('strong:multilingual');
  return { injection: signals.length > 0, signals };
}
