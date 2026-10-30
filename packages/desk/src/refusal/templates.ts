/**
 * Fixed refusal and unknown-field templates.
 *
 * These strings are CODE. No model authors them, edits them, or chooses between
 * them - the classifier picks the language and the template is emitted verbatim.
 * That is what makes a refusal auditable: every refusal for a given class in a
 * given language is byte-identical, so a support ticket claiming "the bot told
 * me to buy" is answerable from the template table alone.
 *
 * A template must never contain a phrase its own classifier would refuse. There
 * is a test that enforces exactly that, because the alternative is a desk whose
 * refusal trips its own gate and degrades into silence.
 */

import type { RefusalClass } from '../../../../config/protocol.js'
import type { LanguageCode } from '../text/normalize.js'

export const REFUSAL_TEMPLATES: Readonly<Record<LanguageCode, string>> = {
  en:
    "I can't take that one. This desk only answers verifiable facts about the token - contract, supply, liquidity, holders, fees, pool - and it names a source for every figure. It does not forecast value, rank tokens against each other, or weigh in on what anyone does with their money. That limit lives in code, so rewording the question does not move it.\nSend /help for the full list of things I can verify for you.",
  es: 'No puedo responder eso. Este canal solo da datos verificables del token - contrato, suministro, liquidez, holders, comisiones y pool - con fuente para cada dato. No opina sobre valor futuro, no ordena tokens entre si, y no participa en decisiones de dinero. El limite esta en el codigo: reformular la pregunta no lo cambia.\nEscribe /help para ver todo lo que puedo verificar.',
  pt: 'Nao posso responder isso. Este canal so fornece dados verificaveis do token - contrato, fornecimento, liquidez, holders, taxas e pool - com fonte para cada numero. Nao opina sobre valor futuro, nao classifica tokens entre si e nao entra em decisoes de dinheiro. O limite esta no codigo: reformular a pergunta nao muda nada.\nEnvie /help para ver tudo o que posso verificar.',
  fr: "Je ne peux pas repondre a cela. Ce guichet ne donne que des faits verifiables sur le token - contrat, offre, liquidite, detenteurs, frais, pool - avec une source pour chaque chiffre. Il ne se prononce pas sur la valeur future, ne classe pas les tokens entre eux et n'intervient pas dans les decisions d'argent. Cette limite est dans le code : reformuler ne la deplace pas.\nEnvoyez /help pour la liste complete de ce que je peux verifier.",
  de: 'Das kann ich nicht beantworten. Dieser Desk liefert nur ueberpruefbare Fakten zum Token - Vertrag, Angebot, Liquiditaet, Holder, Gebuehren, Pool - mit Quelle fuer jede Zahl. Er aeussert sich nicht zu kuenftigem Wert, stellt keine Rangliste von Token auf und mischt sich nicht in Geldentscheidungen ein. Diese Grenze steht im Code; Umformulieren verschiebt sie nicht.\nSchicke /help fuer die vollstaendige Liste.',
  ru: 'Не могу на это ответить. Этот канал даёт только проверяемые факты о токене - контракт, эмиссия, ликвидность, держатели, комиссии, пул - с источником для каждого числа. Он не рассуждает о будущей стоимости, не ранжирует токены и не участвует в денежных решениях. Ограничение записано в коде: переформулировка его не снимает.\nОтправьте /help, чтобы увидеть весь список.',
  tr: 'Buna yanit veremem. Bu masa yalnizca token hakkinda dogrulanabilir verileri paylasir - sozlesme, arz, likidite, sahipler, ucretler, havuz - ve her sayi icin kaynak verir. Gelecekteki deger hakkinda gorus bildirmez, tokenleri siralamaz ve para kararlarina karismaz. Bu sinir kodda; soruyu yeniden yazmak onu degistirmez.\nTum listeyi gormek icin /help yazin.',
  zh: '这个问题我无法回答。本服务台只提供可核验的代币事实——合约、供应量、流动性、持有人、费用、池子——每个数字都附来源。它不评论未来价值，不对代币排序，也不参与资金决定。该限制写在代码里，换一种问法不会改变结果。\n发送 /help 查看我能为你核验的全部内容。',
  ja: 'それにはお答えできません。このデスクは検証可能なトークンの事実のみを扱います（コントラクト、供給量、流動性、保有者、手数料、プール）。数字にはすべて出典が付きます。将来の価値については述べず、トークンの序列も付けず、資金の判断にも関与しません。この制限はコードにあり、言い換えても変わりません。\n/help で扱える項目の一覧を送ります。',
  ko: '그 질문에는 답할 수 없습니다. 이 데스크는 검증 가능한 토큰 사실만 제공합니다 - 컨트랙트, 공급량, 유동성, 보유자, 수수료, 풀 - 모든 수치에 출처가 붙습니다. 미래 가치에 대해 말하지 않고, 토큰의 순위를 매기지 않으며, 자금 결정에 관여하지 않습니다. 이 제한은 코드에 있으며 질문을 바꿔도 달라지지 않습니다.\n/help 를 보내면 확인 가능한 항목 전체를 안내합니다.',
}

/**
 * The unknown-field frame. The field label and the self-check instruction stay
 * in English because they name concrete contract calls; a half-translated call
 * name is worse than an untranslated one.
 */
export const UNKNOWN_FIELD_TEMPLATES: Readonly<Record<LanguageCode, string>> = {
  en: "I don't have {label}. I only repeat values I have verified myself, and I have not verified that one{reason}. Here is how to check it without me: {selfCheck}. {link}",
  es: 'No tengo {label}. Solo repito valores que he verificado yo mismo, y ese no lo tengo verificado{reason}. Asi puedes comprobarlo sin mi: {selfCheck}. {link}',
  pt: 'Nao tenho {label}. So repito valores que eu mesmo verifiquei, e esse nao esta verificado{reason}. Veja como conferir sem mim: {selfCheck}. {link}',
  fr: "Je n'ai pas {label}. Je ne repete que des valeurs que j'ai verifiees moi-meme, et celle-ci ne l'est pas{reason}. Voici comment la verifier sans moi : {selfCheck}. {link}",
  de: 'Mir fehlt {label}. Ich gebe nur Werte weiter, die ich selbst geprueft habe, und dieser ist nicht geprueft{reason}. So pruefst du ihn ohne mich: {selfCheck}. {link}',
  ru: 'У меня нет {label}. Я повторяю только те значения, которые проверил сам, а это не проверено{reason}. Как проверить самостоятельно: {selfCheck}. {link}',
  tr: 'Bende {label} yok. Sadece kendi dogruladigim degerleri tekrarlarim ve bu dogrulanmadi{reason}. Bensiz nasil kontrol edilir: {selfCheck}. {link}',
  zh: '我没有 {label}。我只重复自己核验过的数值，这一项没有核验{reason}。你可以这样自行核对：{selfCheck}。{link}',
  ja: '{label} は持っていません。自分で確認した値だけをお伝えしています。この項目は未確認です{reason}。自分で確認する方法: {selfCheck}. {link}',
  ko: '{label} 정보가 없습니다. 직접 확인한 값만 전달하며, 이 항목은 확인되지 않았습니다{reason}. 직접 확인하는 방법: {selfCheck}. {link}',
}

export const STALE_REASON: Readonly<Record<LanguageCode, string>> = {
  en: ' (my last reading is {age} old, past its freshness limit, so I will not serve it)',
  es: ' (mi ultima lectura tiene {age} y supera el limite de frescura, asi que no la doy)',
  pt: ' (minha ultima leitura tem {age} e passou do limite de frescor, entao nao a uso)',
  fr: ' (ma derniere lecture date de {age}, au-dela de la limite de fraicheur, donc je ne la sers pas)',
  de: ' (meine letzte Messung ist {age} alt und ueber dem Frischelimit, deshalb gebe ich sie nicht aus)',
  ru: ' (последнее измерение сделано {age} назад, срок годности истёк, поэтому я его не выдаю)',
  tr: ' ({age} onceki olcumum tazelik sinirini asti, bu yuzden vermiyorum)',
  zh: '（我上次读取是在 {age} 之前，已超过时效上限，因此不提供）',
  ja: '（最後の取得は {age} 前で、鮮度の上限を超えているため出しません）',
  ko: '(마지막 조회가 {age} 전이라 신선도 한도를 넘어 제공하지 않습니다)',
}

/**
 * Emitted when the desk has no verified answer at all - the model declined, its
 * reply failed the grounding check, or the sheet had nothing usable. One string
 * for all three, because the holder does not care which internal control fired
 * and the honest content is identical.
 */
export const NO_VERIFIED_ANSWER: Readonly<Record<LanguageCode, string>> = {
  en: "I don't have a verified answer to that. I only repeat things I have read myself, and I have not read that. Send /help to see everything I can verify, or check it directly on the explorer.",
  es: 'No tengo una respuesta verificada para eso. Solo repito lo que he leido yo mismo, y eso no lo he leido. Escribe /help para ver todo lo que puedo verificar, o compruebalo en el explorador.',
  pt: 'Nao tenho uma resposta verificada para isso. So repito o que eu mesmo li, e isso eu nao li. Envie /help para ver tudo o que posso verificar, ou confira direto no explorador.',
  fr: "Je n'ai pas de reponse verifiee a cela. Je ne repete que ce que j'ai lu moi-meme, et cela je ne l'ai pas lu. Envoyez /help pour voir tout ce que je peux verifier, ou verifiez directement sur l'explorateur.",
  de: 'Dazu habe ich keine geprüfte Antwort. Ich gebe nur weiter, was ich selbst gelesen habe, und das habe ich nicht gelesen. Schicke /help fuer die vollstaendige Liste, oder pruefe es direkt im Explorer.',
  ru: 'У меня нет проверенного ответа на это. Я повторяю только то, что прочитал сам, а этого я не читал. Отправьте /help, чтобы увидеть весь список, или проверьте напрямую в обозревателе.',
  tr: 'Buna dogrulanmis bir yanitim yok. Sadece kendi okudugumu tekrarlarim ve bunu okumadim. Tum listeyi gormek icin /help yazin veya dogrudan gezginden kontrol edin.',
  zh: '这个问题我没有经过核验的答案。我只重复自己读取过的内容，而这一项我没有读取。发送 /help 查看我能核验的全部内容，或直接在浏览器上核对。',
  ja: 'それについては確認済みの回答がありません。自分で読み取ったものだけをお伝えしています。/help で扱える項目の一覧を送ります。エクスプローラーで直接確認することもできます。',
  ko: '그에 대한 검증된 답이 없습니다. 직접 읽은 내용만 전달합니다. /help 를 보내면 확인 가능한 항목 전체를 안내하며, 익스플로러에서 직접 확인할 수도 있습니다.',
}

export function noVerifiedAnswerBody(language: LanguageCode): string {
  return NO_VERIFIED_ANSWER[language] ?? NO_VERIFIED_ANSWER.en
}

/** Ticket-desk header naming the class, so support can group refusals. */
export const REFUSAL_CLASS_LABEL: Readonly<Record<RefusalClass, string>> = {
  price_prediction: 'price prediction',
  buy_sell_advice: 'trade advice',
  future_value_implication: 'future value',
  user_financial_situation: 'personal finances',
  wen_moon: 'hype timing',
  comparative_investment_merit: 'token ranking',
}

export function refusalBody(language: LanguageCode, ref: string): string {
  const template = REFUSAL_TEMPLATES[language] ?? REFUSAL_TEMPLATES.en
  return `${template}\nRef: ${ref}`
}

/**
 * Refusals that are not an advice class: the desk declines for a reason the
 * classifier does not name. One code, one fixed English body, never a model.
 */
export const REFUSAL_CODES = ['language_unsupported'] as const

export type RefusalCode = (typeof REFUSAL_CODES)[number]

export const REFUSAL_CODE_BODY: Readonly<Record<RefusalCode, string>> = {
  language_unsupported:
    'This desk answers in English only, so I cannot take that one as written. Ask again in English, or send /help for the list of facts I can verify.',
}

export function refusalCodeBody(code: RefusalCode, ref: string): string {
  return `${REFUSAL_CODE_BODY[code]}\nRef: ${ref}`
}

export function unknownFieldBody(
  language: LanguageCode,
  parts: { label: string; selfCheck: string; link?: string; staleAge?: string },
): string {
  const frame = UNKNOWN_FIELD_TEMPLATES[language] ?? UNKNOWN_FIELD_TEMPLATES.en
  const reason =
    parts.staleAge === undefined
      ? ''
      : (STALE_REASON[language] ?? STALE_REASON.en).replace('{age}', parts.staleAge)
  return frame
    .replace('{label}', parts.label)
    .replace('{reason}', reason)
    .replace('{selfCheck}', parts.selfCheck)
    .replace('{link}', parts.link ?? '')
    .trim()
}
