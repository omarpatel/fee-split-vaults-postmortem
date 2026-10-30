/**
 * The language gate. The property under test: a message the desk would answer
 * is refused when it is not English, and nothing that is not language - a
 * command, an address, a ticker, emoji, a two-word question - is ever refused.
 */

import { describe, expect, it } from 'vitest'
import { classifyLanguage, type LanguageVerdict } from '../language.js'
import { classifyRefusal } from '../refusal/classifier.js'
import { REFUSAL_CODE_BODY, refusalCodeBody } from '../refusal/templates.js'

const TABLE: ReadonlyArray<readonly [string, LanguageVerdict, string]> = [
  // Non-Latin scripts, by bucket.
  ['что такое адрес контракта?', 'unsupported', 'cyrillic'],
  ['合约地址是多少？', 'unsupported', 'han'],
  ['コントラクトアドレスを教えてください', 'unsupported', 'kana'],
  ['컨트랙트 주소가 뭐예요?', 'unsupported', 'hangul'],
  ['ما هو عنوان العقد؟', 'unsupported', 'arabic'],
  ['कॉन्ट्रैक्ट का पता क्या है', 'unsupported', 'devanagari'],
  ['ที่อยู่สัญญาคืออะไร', 'unsupported', 'thai'],
  ['ποια ειναι η διευθυνση του συμβολαιου', 'unsupported', 'greek'],
  ['מה כתובת החוזה', 'unsupported', 'hebrew'],
  // Latin-script languages, by stopwords.
  ['¿cuál es la dirección del contrato?', 'unsupported', 'es'],
  ['qual é o endereço do contrato?', 'unsupported', 'pt'],
  ["quelle est l'adresse du contrat ?", 'unsupported', 'fr'],
  ['was ist die adresse des vertrags?', 'unsupported', 'de'],
  ['kontrat adresi nedir acaba', 'unsupported', 'tr'],
  ['apa alamat kontrak ini', 'unsupported', 'id'],
  ['hola quiero comprar ahora', 'unsupported', 'es'],
  // English in all its chat forms.
  ['what is the contract address?', 'english', 'plain'],
  ['WHAT IS THE SUPPLY', 'english', 'caps'],
  ['is the liquidity locked? 🔒🚀', 'english', 'emoji'],
  ['how many holders are there right now 🤔', 'english', 'emoji'],
  ['whats the tax on buys and sells', 'english', 'no apostrophes'],
  ['ｗｈａｔ ｉｓ ｔｈｅ ｓｕｐｐｌｙ', 'english', 'fullwidth folds to Latin'],
  ['shоuld i buy nоw', 'english', 'Cyrillic homoglyph inside English'],
  ['wen moon fren lol', 'english', 'chat slang'],
  ['does the dev have the ca', 'english', 'loanwords beside English'],
  // Nothing to judge.
  ['/price', 'agnostic', 'unknown command'],
  ['/ca@example_bot', 'agnostic', 'addressed command'],
  ['0x2222222222222222222222222222222222222222', 'agnostic', 'address only'],
  ['$VENUE', 'agnostic', 'ticker only'],
  ['🚀🚀🚀', 'agnostic', 'emoji only'],
  ['gm', 'agnostic', 'one word'],
  ['ca?', 'agnostic', 'one word question'],
  ['supply pls', 'agnostic', 'two words'],
  ['hola', 'agnostic', 'one foreign word is not a conversation'],
  ['https://explorer.example/token/0x22', 'agnostic', 'link only'],
  // Mixed-script spam.
  ['🔥 БЕСПЛАТНО airdrop claim 🔥 t.me/x', 'unsupported', 'cyrillic spam around loanwords'],
  ['免费领取 airdrop 点击 claim', 'unsupported', 'han spam around loanwords'],
  ['ca 合约 plz', 'unsupported', 'han beside no English'],
]

describe('language gate: the table', () => {
  for (const [text, verdict, label] of TABLE) {
    it(`${verdict}: ${label}`, () => {
      const decision = classifyLanguage(text)
      expect(decision.verdict, `${text} -> ${decision.reason} ${JSON.stringify(decision)}`).toBe(verdict)
    })
  }
})

describe('language gate: the decision rule', () => {
  it('names the dominant script on a script refusal', () => {
    expect(classifyLanguage('что такое адрес контракта?')).toMatchObject({ reason: 'script', script: 'cyrillic' })
    expect(classifyLanguage('合约地址是多少？')).toMatchObject({ reason: 'script', script: 'han' })
  })

  it('counts stopwords, not length, for Latin text', () => {
    const es = classifyLanguage('¿cuál es la dirección del contrato?')
    expect(es.reason).toBe('latin_foreign')
    expect(es.foreign).toBeGreaterThan(es.english)

    const en = classifyLanguage('what is the contract address?')
    expect(en.reason).toBe('latin_english')
    expect(en.english).toBeGreaterThan(en.foreign)
  })

  it('passes Latin text with no stopword evidence either way', () => {
    expect(classifyLanguage('venue vault factsheet holders').verdict).toBe('english')
  })

  it('ignores addresses, tickers, links and handles when counting', () => {
    const decision = classifyLanguage(
      '@example_bot is $VENUE at 0x2222222222222222222222222222222222222222 on https://explorer.example legit',
    )
    expect(decision.verdict).toBe('english')
    expect(decision.words).toBe(4)
  })

  it('is not fooled by zero-width characters inside a script', () => {
    expect(classifyLanguage('что\u200b такое\u200b адрес\u200b контракта').verdict).toBe('unsupported')
  })
})

describe('language gate: the fixed reply', () => {
  it('is one English line that says so, plus the reference', () => {
    const body = refusalCodeBody('language_unsupported', 'R-ABC123')
    expect(body).toBe(`${REFUSAL_CODE_BODY.language_unsupported}\nRef: R-ABC123`)
    expect(REFUSAL_CODE_BODY.language_unsupported).toContain('English only')
    expect(REFUSAL_CODE_BODY.language_unsupported.includes('\n')).toBe(false)
  })

  it('passes the output gate and reads as English to its own detector', () => {
    expect(classifyRefusal(REFUSAL_CODE_BODY.language_unsupported, 'output').refused).toBe(false)
    expect(classifyLanguage(REFUSAL_CODE_BODY.language_unsupported).verdict).toBe('english')
  })
})
