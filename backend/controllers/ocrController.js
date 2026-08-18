const axios = require('axios')
const pdfParse = require('pdf-parse')
const InsuranceCompany = require('../models/InsuranceCompany')

/**
 * IFFCO Tokio PDFs have a combined line like:
 *   "COMPANY NAMEPolicy #:1-8H9WT9SUP400 Policy #N7964694"
 * where the FIRST Policy # is the Tax Invoice / internal ref and
 * the SECOND Policy # is the actual policy number.
 * This helper detects that pattern and returns the correct policy number.
 */
const extractIffcoTokioPolicyNumber = (rawText) => {
  if (!rawText) return null

  // Pattern: one line containing two "Policy #" occurrences
  // e.g. "...Policy #:1-8H9WT9SUP400 Policy #N7964694"
  // The actual policy number follows the LAST "Policy #" on that line.
  const lines = rawText.split('\n')
  for (const line of lines) {
    // Count occurrences of "Policy #" (case-insensitive)
    const matches = [...line.matchAll(/Policy\s*#\s*:?\s*([^\s]+)/gi)]
    if (matches.length >= 2) {
      // The last match is the actual policy number
      const actualPolicyNo = matches[matches.length - 1][1].trim()
      if (actualPolicyNo) {
        console.log('[IFFCO-Tokio] Detected dual Policy# line. Overriding policy number to:', actualPolicyNo)
        return actualPolicyNo
      }
    }
  }
  return null
}

/**
 * Some insurers (e.g. Go Digit) print a clean "ENDORSEMENT" invoice table:
 *   "Invoice Number Invoice Date Net Premium Igst Cgst Sgst Utgst Cess Gross Premium
 *    IA250592477 2026-04-11 1002.29 0.00 90.21 90.21 0.00 0.00 1182.71"
 * pdf-parse concatenates the row's numbers with no separators (each is a clean
 * 2-decimal amount, so they can be split unambiguously), while the OD/TP
 * breakdown table above it gets its labels and values scrambled out of order.
 * This table is unambiguous, so use it to correct netPremium/premium (gross)
 * when present, overriding whatever the AI guessed.
 */
/**
 * Bajaj Allianz PDFs render the premium breakdown as a two-column table
 * (OWN DAMAGE | LIABILITY) that pdf-parse flattens into a single stream.
 * The AI therefore ends up reading values like "Net Premium 714.00" and
 * incorrectly assigns 714 to both netPremium AND premium, missing the
 * unambiguous line "Final Premium Rs.843.00" that appears right below.
 *
 * This helper finds that "Final Premium Rs." label and returns the correct
 * gross premium value so we can override whatever the AI guessed.
 *
 * It also extracts the Net Premium (before GST) from the same block so we
 * can verify: Final Premium ≈ Net Premium × 1.18.
 */
const extractBajajFinalPremium = (rawText) => {
  if (!rawText) return null

  // Match: "Final Premium Rs.843.00" or "Final Premium Rs. 843" or "Final Premium Rs843.00"
  const finalMatch = rawText.match(/Final\s*Premium\s*Rs\.?\s*([\d,]+(?:\.\d{1,2})?)/i)
  if (!finalMatch) return null

  const finalPremium = Number(finalMatch[1].replace(/,/g, ''))
  if (!finalPremium || isNaN(finalPremium)) return null

  // Also extract Net Premium from the same block for cross-validation
  // Bajaj prints: "Net Premium714.00" or "Net Premium 714.00"
  const netMatch = rawText.match(/Net\s*Premium\s*([\d,]+(?:\.\d{1,2})?)/i)
  const netPremium = netMatch ? Number(netMatch[1].replace(/,/g, '')) : null

  // Sanity check: Final Premium must be > Net Premium (GST pushes it up ~18%)
  if (netPremium != null && finalPremium <= netPremium) {
    console.log('[Bajaj] Final Premium not > Net Premium — skipping override:', finalPremium, 'vs', netPremium)
    return null
  }

  console.log('[Bajaj] Extracted Final Premium:', finalPremium, '| Net Premium:', netPremium)
  return { finalPremium, netPremium }
}

const extractNetGrossPremiumFromEndorsementTable = (rawText) => {
  if (!rawText) return null
  const match = rawText.match(/Net\s*Premium\s*Igst\s*Cgst\s*Sgst\s*Utgst\s*Cess\s*Gross\s*Premium[\s\S]{0,60}?\d{4}-\d{2}-\d{2}((?:\d+\.\d{2}){7})/i)
  if (!match) return null
  const numbers = match[1].match(/\d+\.\d{2}/g)
  if (!numbers || numbers.length !== 7) return null
  const [netPremium, , , , , , grossPremium] = numbers
  return { netPremium: Number(netPremium), premium: Number(grossPremium) }
}

/**
 * Go Digit policy schedules print an OD/TP premium breakdown table where
 * pdf-parse scrambles the labels away from their values (columns get
 * flattened out of reading order), so the AI regularly grabs the wrong
 * number (e.g. picks the TP figure for OD, or vice-versa). However the
 * table always ends with one clean, unambiguous final summary row right
 * before the "Note:...total OD premium..." disclaimer:
 *   "(`) 288.29 96.10 714.00 Note:The above total OD premium is..."
 * which is always [Total OD Premium, NCB amount, Total Act/TP Premium] in
 * that fixed order. Cross-check against the known netPremium (OD + TP)
 * before trusting it, so a template change can't silently corrupt data.
 */
const extractDigitOdTpPremium = (rawText, knownNetPremium) => {
  if (!rawText) return null
  const match = rawText.match(/\(`\)\s*(\d+\.\d{2})\s*(\d+\.\d{2})\s*(\d+\.\d{2})\s*Note:\s*The above total OD premium/i)
  if (!match) return null
  const odPremium = Number(match[1])
  const tpPremium = Number(match[3])
  if (knownNetPremium != null) {
    const diff = Math.abs(odPremium + tpPremium - knownNetPremium)
    if (diff > 2) return null // doesn't reconcile with net premium, don't risk a bad override
  }
  return { odPremium, tpPremium }
}

/**
 * Go Digit PDFs print policy dates in a two-column table:
 *   Col 1: Own Damage Cover period  |  Col 2: Third Party Liability Cover period
 * pdf-parse flattens this into a sequence of 4 consecutive date strings:
 *   [OD From, TP From, OD To, TP To]
 * right after the "Period of Policy" header line.
 *
 * Problem: the same page also has a line like "D262115781 / 11042026" where
 * "11042026" is the policy issue date concatenated with the policy number.
 * The AI reads that as "11-04-2026" and uses it as validFrom instead of the
 * correct "12-Apr-2026" from the table.
 *
 * This helper extracts the 4 dates from the table in the correct column
 * order and returns them for use as an override in the post-processor.
 *
 * Format of dates in Go Digit PDFs: "12-Apr-2026", "11-Apr-2027" etc.
 * We normalise to DD-MM-YYYY for the stored fields.
 */
const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12'
}

const normaliseDateDDMMYYYY = (dateStr) => {
  if (!dateStr) return null
  // Already DD-MM-YYYY or DD/MM/YYYY
  if (/^\d{2}[-/]\d{2}[-/]\d{4}$/.test(dateStr)) {
    return dateStr.replace(/\//g, '-')
  }
  // DD-Mon-YYYY e.g. "12-Apr-2026"
  const m = dateStr.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})$/)
  if (m) {
    const mm = MONTH_MAP[m[2].toLowerCase()]
    if (!mm) return null
    return `${m[1].padStart(2, '0')}-${mm}-${m[3]}`
  }
  return null
}

const extractDigitPolicyDates = (rawText) => {
  if (!rawText) return null

  // Look for the block: "Period of Policy Own Damage Cover..." followed by
  // 4 date values in the format "DD-Mon-YYYY" within the next ~300 chars.
  // The column order is always: OD-From, TP-From, OD-To, TP-To
  const blockMatch = rawText.match(
    /Period\s+of\s+Policy[^\n]*(?:Own\s+Damage|OD)[^\n]*((?:\n[^\n]*)*)/i
  )
  if (!blockMatch) return null

  // Collect all DD-Mon-YYYY (or DD-MM-YYYY) dates from the block
  const block = blockMatch[0]
  const datePattern = /\b(\d{1,2}-(?:[A-Za-z]{3}|\d{2})-\d{4})\b/g
  const dates = []
  let m
  while ((m = datePattern.exec(block)) !== null) {
    const normalised = normaliseDateDDMMYYYY(m[1])
    if (normalised) dates.push(normalised)
    if (dates.length === 4) break
  }

  // We need at least 2 dates (From, To for OD) to be useful
  if (dates.length < 2) return null

  // Column order: [OD-From, TP-From, OD-To, TP-To]
  // If only 2 dates found it's a TP-only policy: [TP-From, TP-To]
  const result = {}
  if (dates.length >= 4) {
    result.validFrom = dates[0]   // OD From
    result.validTo = dates[2]   // OD To
    result.tpValidFrom = dates[1] // TP From
    result.tpValidTo = dates[3] // TP To
  } else if (dates.length === 3) {
    // OD-From, OD-To, TP-To (TP-From same as OD-From)
    result.validFrom = dates[0]
    result.validTo = dates[1]
    result.tpValidFrom = dates[0]
    result.tpValidTo = dates[2]
  } else {
    result.validFrom = dates[0]
    result.validTo = dates[1]
  }

  console.log('[GoDigit] Extracted policy dates from Period-of-Policy block:', result)
  return result
}

/**
 * HDFC ERGO policy schedules (especially Standalone OD / Two Wheeler OD Only)
 * display a breakdown table like:
 *   Own Damage Premium(a)(`)  Liability Premium(b)(`)
 *   Basic Own Damage: 577
 *   Total Premium (a+b) 935
 *   Integrated Tax 18% 168
 *   ...
 *   Net Own Damage Premium (a) 935
 *   Total Premium 1103
 *
 * For Standalone OD policies, Liability Premium (b) is blank/empty, but the AI
 * often mistakes "Integrated Tax 18% 168" as tpPremium! Also "Total Premium (a+b) 935"
 * is the netPremium (before 18% GST).
 *
 * This helper extracts the clean figures from HDFC ERGO policy text.
 */
const extractHdfcErgoPremiums = (rawText) => {
  if (!rawText) return null

  const isHdfc = /HDFC\s*ERGO/i.test(rawText)
  if (!isHdfc) return null

  const isStandaloneOd = /Standalone\s*OD/i.test(rawText) || /Own\s*Damage\s*Only/i.test(rawText)

  // 1. Net Own Damage Premium (a)
  const netOdMatch = rawText.match(/Net\s*Own\s*Damage\s*Premium\s*\(a\)[^\d]*(\d+(?:\.\d{1,2})?)/i)
  const odPremium = netOdMatch ? Number(netOdMatch[1]) : null

  // 2. Total Premium (a+b) -> Net Premium
  const totalNetMatch = rawText.match(/Total\s*Premium\s*\(a\+b\)[^\d]*(\d+(?:\.\d{1,2})?)/i)
  const netPremium = totalNetMatch ? Number(totalNetMatch[1]) : (odPremium ?? null)

  // 3. Gross Premium: "Total Premium\n1103"
  let grossPremium = null
  const grossMatch = rawText.match(/Net\s*Own\s*Damage\s*Premium[\s\S]{0,100}?Total\s*Premium[^\d]*(\d+(?:\.\d{1,2})?)/i)
    || rawText.match(/Total\s*Premium\s*\(a\+b\)[\s\S]{0,150}?Total\s*Premium[^\d]*(\d+(?:\.\d{1,2})?)/i)
  if (grossMatch) {
    grossPremium = Number(grossMatch[1])
  }

  // 4. TP Premium
  let tpPremium = ''
  if (!isStandaloneOd) {
    const liabMatch = rawText.match(/(?:Net|Total)\s*Liability\s*Premium\s*\(b\)[^\d]*(\d+(?:\.\d{1,2})?)/i)
    if (liabMatch) {
      tpPremium = Number(liabMatch[1])
    }
  }

  return {
    odPremium,
    tpPremium,
    netPremium,
    premium: grossPremium,
    isStandaloneOd
  }
}

/**
 * IFFCO Tokio PDFs (especially Standalone OD policies) print a Premium Bifurcation table
 * where numbers are concatenated in raw text:
 *   "Premium Bifurcation (Rs.) Section 1 (Rs.) Section 2 (Rs.) Premium/Taxable Value(Rs.) Total GST Net Premium Rs.(for 1 years)"
 *   "622.00174.00796.00143.28939.28"
 *
 * Here:
 * - Section 1 (OD Net): 622.00
 * - Section 2 (Addons): 174.00
 * - Premium/Taxable Value (Total Net OD): 796.00
 * - Total GST: 143.28
 * - Net Premium Rs. (Gross): 939.28
 *
 * For Standalone OD policies, Third Party details belong to a different insurer
 * (e.g. Shriram General Ins) and are for reference only.
 */
const extractIffcoTokioPremiums = (rawText) => {
  if (!rawText) return null

  const isIffco = /IFFCO\s*[-–]?\s*TOKIO/i.test(rawText)
  if (!isIffco) return null

  const isStandaloneOd = /Stand\s*Alone\s*OD/i.test(rawText)
    || /Standalone\s*OD/i.test(rawText)
    || /Own\s*Damage\s*Only/i.test(rawText)
    || /TP\s*Insurer\s*Name\s*:/i.test(rawText)

  const bifMatch = rawText.match(/Premium\s*Bifurcation[\s\S]{0,150}?((?:\d+\.\d{2}){5})/i)
    || rawText.match(/Section\s*1\s*\(Rs\.\)[\s\S]{0,150}?((?:\d+\.\d{2}){5})/i)

  let sec1 = null, sec2 = null, taxableValue = null, totalGst = null, grossVal = null
  if (bifMatch) {
    const nums = bifMatch[1].match(/\d+\.\d{2}/g)
    if (nums && nums.length === 5) {
      sec1 = Number(nums[0])
      sec2 = Number(nums[1])
      taxableValue = Number(nums[2])
      totalGst = Number(nums[3])
      grossVal = Number(nums[4])
    }
  }

  const netPremium = taxableValue ?? (sec1 != null ? sec1 + (sec2 || 0) : null)
  const odPremium = isStandaloneOd ? netPremium : (sec1 ?? netPremium)
  const tpPremium = isStandaloneOd ? '' : null

  return {
    isStandaloneOd,
    sec1,
    sec2,
    taxableValue,
    totalGst,
    grossVal,
    odPremium,
    netPremium,
    premium: grossVal,
    tpPremium
  }
}

/**
 * Indian vehicle registration numbers follow the pattern:
 *   <2-letter state code><2-digit district><1-3 letter series><4-digit number>
 * Total length after stripping hyphens/spaces: 9 or 10 characters.
 * Examples: CG04NS0396, MH12AB1234, DL1CAB1234
 *
 * If the AI returns a vehicleNumber that is clearly wrong (too long, looks like
 * Engine No or Chassis No concatenation), this helper scans the raw PDF text
 * for a valid Indian registration number and returns it.
 */
const INDIAN_REG_NO_PATTERN = /\b([A-Z]{2}\d{2}[A-Z]{1,3}\d{4})\b/g

const isValidIndianVehicleNumber = (val) => {
  if (!val) return false
  const stripped = val.replace(/[\s-]/g, '').toUpperCase()
  return /^[A-Z]{2}\d{2}[A-Z]{1,3}\d{4}$/.test(stripped) // 9 or 10 chars
}

/**
 * Check if the document or extracted candidate indicates a NEW / Unregistered vehicle.
 * E.g. "Registration No. NEW", "NEW VEHICLE", "UNREGISTERED", "APPLIED FOR", "TO BE REGISTERED"
 */
const isNewVehicleRegistration = (rawText, val) => {
  if (val) {
    const clean = val.trim().toUpperCase().replace(/[\s.-]/g, '')
    if (clean.startsWith('NEW') || clean.includes('UNREGISTERED') || clean.includes('APPLIEDFOR') || clean.includes('NOTREGISTERED') || clean.includes('TOBEREGISTERED') || clean === 'TBR' || clean === 'NA' || clean === 'PROVISIONAL') {
      return true
    }
  }

  if (rawText) {
    const match = rawText.match(/(?:Registration\s*(?:Mark\s*(?:&|AND)?\s*Place|Mark|Number|No\.?)|Reg(?:istration)?\s*(?:Number|No\.?)|Vehicle\s*(?:Number|No\.?))\s*[:\-]?\s*(NEW|UNREGISTERED|APPLIED\s*FOR|NOT\s*REGISTERED|TO\s*BE\s*REGISTERED|T\.?B\.?R\.?|N\/?A|PROVISIONAL)/i)
    if (match) {
      return true
    }

    // Shriram / Universal Sompo / similar insurers:
    // pdf-parse concatenates table columns into single lines without spaces like:
    //   "NEW & RAIPURJK15EG5309259..." or "REGISTRATION NUMBERNEWPERIOD OF INSURANCE"
    const newPlaceMatch = rawText.match(/(?:^|\n)\s*NEW\s*&\s*[A-Z]{2,}/im)
    if (newPlaceMatch) {
      return true
    }

    const regNumNewConcatMatch = rawText.match(/REGISTRATION\s*(?:NUMBER|MARK|NO)?\s*[:\-]?\s*NEW/i)
    if (regNumNewConcatMatch) {
      return true
    }

    // Also catch "Registration Mark & Place ... NEW" style label-value on separate lines
    const regMarkPlaceMatch = rawText.match(/REGISTRATION\s*MARK\s*(?:&|AND)?\s*PLACE[\s\S]{0,200}?\bNEW\b/i)
    if (regMarkPlaceMatch) {
      return true
    }
  }

  return false
}

const extractValidIndianVehicleNumber = (rawText) => {
  if (!rawText) return null

  // If document indicates a NEW / Unregistered vehicle, return empty string
  if (isNewVehicleRegistration(rawText, null)) {
    console.log('[VehicleNo] Document indicates New/Unregistered vehicle. Returning empty vehicleNumber.')
    return ''
  }

  // 1. Try labeled matches: look for lines containing Registration keywords
  const labeledPattern = /(?:Registration\s*(?:Mark\s*&?\s*)?No\.?|Reg(?:istration)?\s*No\.?|Vehicle\s*No\.?)\s*[:\-]?\s*([A-Z]{2}[\s-]?\d{2}[\s-]?[A-Z]{1,3}[\s-]?\d{4})/gi
  const labeledMatch = rawText.match(labeledPattern)
  if (labeledMatch) {
    for (const m of labeledMatch) {
      const numMatch = m.match(/([A-Z]{2}[\s-]?\d{2}[\s-]?[A-Z]{1,3}[\s-]?\d{4})/i)
      if (numMatch) {
        const candidate = numMatch[1].replace(/[\s-]/g, '').toUpperCase()
        if (isValidIndianVehicleNumber(candidate)) {
          console.log('[VehicleNo] Extracted from label:', candidate)
          return candidate
        }
      }
    }
  }

  // 2. Fallback: scan all tokens in the text for Indian reg-no shaped strings
  //    Prefer shorter valid matches (9-10 chars) over concatenated junk
  const candidates = []
  let m
  const re = new RegExp(INDIAN_REG_NO_PATTERN.source, 'g')
  while ((m = re.exec(rawText.replace(/[\s-]/g, ' ').replace(/ /g, ''))) !== null) {
    // Run on original text lines to avoid cross-line concatenation
    candidates.push(m[1])
  }

  // Also scan line by line to catch values concatenated with year (e.g. "CG04NS03962022")
  const lines = rawText.split('\n')
  for (const line of lines) {
    const stripped = line.replace(/[\s-]/g, '').toUpperCase()
    // Match Indian reg no possibly followed by 4-digit year
    const lineMatch = stripped.match(/^([A-Z]{2}\d{2}[A-Z]{1,3}\d{4})(\d{4})?/)
    if (lineMatch && isValidIndianVehicleNumber(lineMatch[1])) {
      candidates.push(lineMatch[1])
    }
  }

  if (candidates.length > 0) {
    // Return the first valid unique candidate
    const unique = [...new Set(candidates)]
    console.log('[VehicleNo] Candidates found:', unique)
    return unique[0]
  }

  return null
}

/**
 * Extract the policy issue date directly from raw PDF text.
 * Searches for labels like "Invoice Date", "Issue Date", "Policy Issue Date",
 * "Date of Issue", "Receipt Date", "Collection Date", "Policy Date", "signed at ... on" etc.
 * Converts DD/MM/YYYY or YYYY-MM-DD or D-Mon-YYYY to DD-MM-YYYY.
 * Returns null if not found.
 */
const extractIssueDateFromRawText = (rawText) => {
  if (!rawText) return null

  // Normalize date: converts D/M/YYYY or DD/MM/YYYY -> DD-MM-YYYY
  //                 or YYYY-MM-DD -> DD-MM-YYYY
  //                 or D-Mon-YYYY -> DD-MM-YYYY
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
  const normalize = (d, m, y) => {
    let dd = String(d).padStart(2, '0')
    let mm
    if (/^\d+$/.test(String(m))) {
      mm = String(m).padStart(2, '0')
    } else {
      const mo = MONTHS[String(m).slice(0, 3).toLowerCase()]
      mm = mo ? String(mo).padStart(2, '0') : null
    }
    if (!mm) return null
    const yyyy = String(y)
    if (yyyy.length !== 4) return null
    return `${dd}-${mm}-${yyyy}`
  }

  // Labels to search for (in priority order)
  const LABEL_PATTERNS = [
    /(?:Invoice|GST\s+Invoice)\s*Date\s*[:\-]?\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i,
    /(?:Receipt|Reciept|Collection|Payment)\s*Date\s*[:\-]?\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i,
    /(?:Receipt|Reciept|Collection|Payment)\s*[\s\S]{0,30}?Date\s*[:\-]?\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i,
    /(?:Policy\s+Issue|Issue|Date\s+of\s+(?:Issue|Issuance|Collection|Receipt))\s*Date\s*[:\-]?\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i,
    /(?:Policy\s*Date|Issue\s*Date|Proposal\s*Date)\s*[:\-]?\s*(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i,
    /signed\s+at\s+\S+\s+on\s+(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/i,
    /Vehicle\s+purchased\s+on\s+(?:dated\s*)?[:\-]?\s*(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/i,
  ]

  for (const pattern of LABEL_PATTERNS) {
    const m = rawText.match(pattern)
    if (m) {
      if (m[3] && m[3].length === 4) {
        const result = normalize(m[1], m[2], m[3])
        if (result) return result
      } else if (m[1] && m[1].length === 4) {
        const result = normalize(m[3], m[2], m[1])
        if (result) return result
      }
    }
  }

  return null
}

const HIGH_VALUE_KEYWORDS = [
  'registration no', 'vehicle no', 'engine number', 'chassis', 'make', 'model',
  'policy no', 'policy number', 'valid from', 'valid till', 'period of insurance',
  'premium', 'total premium', 'od premium', 'own damage premium', 'tp premium',
  'third party premium', 'liability premium', 'net premium', 'gross premium',
  'total od premium', 'total act premium', 'final premium', 'ncb',
  'insured', 'insured name', 'receipt', 'proposal',
  'certificate of insurance', 'policy schedule', 'fuel type', 'seating capacity',
  'mfg. year', 'manufacture year', 'date of registration', 'body type'
]

/**
 * Try to extract text from a PDF buffer using pdf-parse.
 * If pdf-parse fails (e.g. damaged xref/catalog), fall back to pdftotext
 * (Xpdf/Poppler command-line tool which handles damaged PDFs).
 * Returns { text, numpages } or throws if both fail.
 */
const parsePdfWithFallback = async (buffer) => {
  try {
    return await pdfParse(buffer)
  } catch (primaryErr) {
    console.warn('[PDF] pdf-parse failed (' + (primaryErr.message || primaryErr) + '), trying pdftotext fallback...')
    const { execFile } = require('child_process')
    const fs = require('fs')
    const os = require('os')
    const path = require('path')
    const tmpIn = path.join(os.tmpdir(), 'ocr_tmp_' + Date.now() + '.pdf')
    const tmpOut = path.join(os.tmpdir(), 'ocr_tmp_' + Date.now() + '.txt')
    try {
      fs.writeFileSync(tmpIn, buffer)
      await new Promise((resolve, reject) => {
        execFile('pdftotext', ['-layout', tmpIn, tmpOut], (err) => {
          if (err) reject(err); else resolve();
        })
      })
      const text = fs.readFileSync(tmpOut, 'utf8')
      return { text, numpages: (text.match(/\f/g) || []).length + 1 }
    } finally {
      try { fs.unlinkSync(tmpIn) } catch (_) { }
      try { fs.unlinkSync(tmpOut) } catch (_) { }
    }
  }
}

const extractRelevantPdfText = (fullText) => {
  let cleaned = fullText.replace(/[\u0900-\u097F]+/g, '').trim()

  const BOILERPLATE = [
    /Motor Vehicles? Act[^\n]{0,300}/gi,
    /Central Motor Vehicle[^\n]{0,250}/gi,
    /amended from time to time[^\n]{0,200}/gi,
    /Arbitration Clause[^\n]{0,200}/gi,
    /AVOIDANCE OF CERTAIN[^\n]{0,300}/gi,
    /RIGHT OF RECOVERY[^\n]{0,300}/gi,
    /Office of the Insurance Ombudsman[^\n]{0,400}/gi,
    /IN WITNESS WHEREOF[^\n]{0,400}/gi,
    /PersonsorClassofPersons[^\n]{0,400}/gi,
    /Usein connection[^\n]{0,400}/gi,
    /Thepolicydoesnot[^\n]{0,400}/gi,
    /IRDAI\/NL\/CIR[^\n]{0,300}/gi,
  ]
  for (const pattern of BOILERPLATE) cleaned = cleaned.replace(pattern, '')

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()

  const segments = cleaned.split(/(?:Page\s*(?:no\.?|number)?\s*[:\-]?\s*\d+\s*(?:of\s*\d+)?)/i)
    .filter(s => s.trim().length > 50)

  if (segments.length <= 1) {
    return cleaned.slice(0, 6000)
  }

  const scored = segments.map((seg, i) => {
    const lower = seg.toLowerCase()
    const score = HIGH_VALUE_KEYWORDS.reduce((acc, kw) => acc + (lower.includes(kw) ? 1 : 0), 0)
    return { seg, score, i }
  })

  const topSegments = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .sort((a, b) => a.i - b.i)

  const result = topSegments.map(s => s.seg.trim()).join('\n\n---\n\n')

  return result.slice(0, 7000)
}

/**
 * National Insurance Company (NIC) PDFs use a two-column premium table
 * that pdf-parse cannot handle. This helper extracts:
 *   tpPremium:   TP Total (Rounded Off)
 *   odPremium:   OD Total (Rounded Off)  — empty for TP-only policies
 *   netPremium:  TOTAL PREMIUM (before GST)
 *   premium:     NET PAYABLE (after GST)
 *   insuranceClass: 'Third Party' | 'Comprehensive' | 'Standalone OD'
 * from the raw text.
 */
const extractNationalInsurancePremiums = (rawText) => {
  if (!rawText) return null
  if (!/National\s+Insurance/i.test(rawText)) return null

  // Helper: extract last monetary amount on a matched line
  const extractLastAmtOnLine = (pattern, text) => {
    const m = text.match(pattern)
    if (!m) return null
    const nums = m[0].match(/([\d,]+\.\d{2})/g)
    if (!nums) return null
    const n = parseFloat(nums[nums.length - 1].replace(/,/g, ''))
    return isNaN(n) ? null : n
  }

  // Determine policy class from document text
  const isLiabilityOnly = /Liability\s+Only|Third\s+Party\s+Only/i.test(rawText)
  const isStandaloneOd = /Standalone\s+OD|Own\s+Damage\s+Only/i.test(rawText)

  // Extract TP Total (Rounded Off) — last number on that line
  const tpTotal = extractLastAmtOnLine(/TP\s+Total\s*\(?Rounded\s*Off\)?[^\n]*/i, rawText)

  // Extract OD Total (Rounded Off) — last number on that line
  const odTotal = extractLastAmtOnLine(/OD\s+Total\s*\(?Rounded\s*Off\)?[^\n]*/i, rawText)

  // Extract TOTAL PREMIUM (net before GST) — last number on that line
  const netPremium = extractLastAmtOnLine(/TOTAL\s+PREMIUM[^\n]*/i, rawText)

  // Extract NET PAYABLE (gross after GST) — last number on that line
  const premium = extractLastAmtOnLine(/NET\s+PAYABLE[^\n]*/i, rawText)

  // For Liability Only: OD is empty, tpPremium = netPremium (TOTAL PREMIUM)
  // For Comprehensive: both OD and TP are present

  if (tpTotal == null && netPremium == null && odTotal == null) return null

  let insuranceClass = 'Comprehensive'
  if (isLiabilityOnly) insuranceClass = 'Third Party'
  else if (isStandaloneOd) insuranceClass = 'Standalone OD'

  const result = {
    insuranceClass,
    odPremium: odTotal,
    tpPremium: isLiabilityOnly ? netPremium : tpTotal,
    netPremium,
    premium,
  }
  console.log('[NIC] Extracted premiums:', result)
  return result
}

/**
 * Royal Sundaram PDFs are multi-page and pdf-parse's segment scoring often
 * selects marketing/info pages over the actual premium breakdown page.
 * This helper reads premiums directly from the raw text so they are never lost.
 *
 * Format in raw text (interleaved columns, read by pdf-parse):
 *   TOTAL OWN DAMAGE PREMIUM (A)\n11530
 *   NET PREMIUM (A + B)19477
 *   TOTAL LIABILITY PREMIUM (B)\n7947
 *   TOTAL PREMIUM PAYABLE\n22982.86   OR   Gross Premium22982.86
 */
const extractRoyalSundaramPremiums = (rawText) => {
  if (!rawText) return null
  if (!/Royal\s+Sundaram/i.test(rawText)) return null

  const parseAmt = (str) => {
    if (str == null) return null
    const n = parseFloat(String(str).replace(/,/g, '').trim())
    return isNaN(n) ? null : n
  }

  // Extract last number on line or first number on next line
  const extractAfterLabel = (pattern, text) => {
    const m = text.match(pattern)
    if (!m) return null
    // Try numbers on same line
    const sameLineNums = m[0].match(/([\d,]+\.?\d*)/g)
    if (sameLineNums && sameLineNums.length > 0) {
      const n = parseAmt(sameLineNums[sameLineNums.length - 1])
      if (n != null && n > 0) return n
    }
    return null
  }

  // TOTAL OWN DAMAGE PREMIUM (A) — value on next line
  let odPremium = null
  const odMatch = rawText.match(/TOTAL\s+OWN\s+DAMAGE\s+PREMIUM\s*\(?A\)?[^\n]*\n([^\n]+)/i)
  if (odMatch) odPremium = parseAmt(odMatch[1].match(/([\d,]+\.?\d*)/)?.[0])

  // TOTAL LIABILITY PREMIUM (B) — value on next line
  let tpPremium = null
  const tpMatch = rawText.match(/TOTAL\s+LIABILITY\s+PREMIUM\s*\(?B\)?[^\n]*\n([^\n]+)/i)
  if (tpMatch) tpPremium = parseAmt(tpMatch[1].match(/([\d,]+\.?\d*)/)?.[0])

  // NET PREMIUM (A + B) — value on same line concatenated
  let netPremium = null
  const netMatch = rawText.match(/NET\s+PREMIUM\s*\(?A\s*\+\s*B\)?([^\n]+)/i)
  if (netMatch) {
    const nums = netMatch[1].match(/([\d,]+\.?\d*)/g)
    if (nums) netPremium = parseAmt(nums[nums.length - 1])
  }

  // Gross Premium / TOTAL PREMIUM PAYABLE — value on same line or next line
  let premium = null
  const grossMatch = rawText.match(/(?:Gross\s+Premium|TOTAL\s+PREMIUM\s+PAYABLE)([^\n]*)(?:\n([^\n]*))?/i)
  if (grossMatch) {
    const sameLine = grossMatch[1].match(/([\d,]+\.\d{2})/g)
    if (sameLine) premium = parseAmt(sameLine[sameLine.length - 1])
    else if (grossMatch[2]) {
      const nextLine = grossMatch[2].match(/([\d,]+\.\d{2})/g)
      if (nextLine) premium = parseAmt(nextLine[0])
    }
  }

  if (odPremium == null && tpPremium == null && netPremium == null) return null

  const result = { odPremium, tpPremium, netPremium, premium }
  console.log('[RoyalSundaram] Extracted premiums:', result)
  return result
}

// Groq free-tier keys have a daily token/request limit. We keep a small pool
// of keys and rotate to the next one whenever the current key gets rate
// limited (HTTP 429 / rate_limit_exceeded), so OCR keeps working across the
// combined daily quota of all configured keys.
const GROQ_API_KEYS = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(Boolean)
let activeGroqKeyIndex = 0

const isRateLimitError = (err) => {
  const status = err.response?.status
  const code = err.response?.data?.error?.code
  return status === 429 || code === 'rate_limit_exceeded'
}

const isNetworkOrRateLimitError = (err) => {
  const errCode = err.code
  return isRateLimitError(err) || errCode === 'ECONNRESET' || errCode === 'ETIMEDOUT' || errCode === 'ECONNREFUSED' || errCode === 'ENOTFOUND' || errCode === 'EAI_AGAIN'
}

const withGroqKeyRotation = async (requestFn) => {
  let lastErr
  const maxAttempts = Math.max(GROQ_API_KEYS.length * 2, 4)
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const key = GROQ_API_KEYS[activeGroqKeyIndex]
    try {
      return await requestFn(key)
    } catch (err) {
      lastErr = err
      if (isNetworkOrRateLimitError(err)) {
        if (isRateLimitError(err) && GROQ_API_KEYS.length > 1) {
          console.warn(`Groq API key #${activeGroqKeyIndex + 1} hit its rate limit, switching to next key...`)
          activeGroqKeyIndex = (activeGroqKeyIndex + 1) % GROQ_API_KEYS.length
        } else {
          console.warn(`Groq API request encountered temporary network error (${err.code || err.message}), retrying (attempt ${attempt + 1}/${maxAttempts})...`)
          await new Promise(r => setTimeout(r, 1000))
        }
        continue
      }
      throw err
    }
  }
  throw lastErr
}

const GET_TEXT_MODELS = () => {
  const custom = process.env.GROQ_TEXT_MODEL
  const defaults = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.6-27b']
  return [...new Set([custom, ...defaults].filter(Boolean))]
}

const GET_VISION_MODELS = () => {
  const custom = process.env.GROQ_VISION_MODEL
  const defaults = ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b']
  return [...new Set([custom, ...defaults].filter(Boolean))]
}

const callGroqAPI = async (imageBase64, textPrompt, isPdf = false, backImageBase64 = null) => {
  if (GROQ_API_KEYS.length === 0) {
    throw new Error('GROQ_API_KEY is not configured')
  }

  if (isPdf) {
    const sanitizedText = imageBase64
      .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
      .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st')
      .replace(/\u0000/g, ' ')
      .replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]/g, ' ')
      .replace(/[ \t]{3,}/g, '  ')
      .trim()

    const messages = [
      {
        role: 'system',
        content: 'You are a precise insurance document data extractor. Extract ONLY values that literally appear in the document text. Never guess or invent values. Output valid JSON only.'
      },
      {
        role: 'user',
        content: `<DOCUMENT>\n${sanitizedText}\n</DOCUMENT>\n\n${textPrompt}`
      }
    ]

    const textModels = GET_TEXT_MODELS()
    let lastError = null

    for (const model of textModels) {
      const makeRequest = (withFormat) => withGroqKeyRotation((key) => {
        const body = {
          model,
          messages,
          temperature: 0,
          max_completion_tokens: 2048,
          max_tokens: 2048
        }
        if (withFormat) body.response_format = { type: 'json_object' }
        return axios.post('https://api.groq.com/openai/v1/chat/completions', body, {
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
        })
      })

      try {
        return await makeRequest(true)
      } catch (firstErr) {
        lastError = firstErr
        const errCode = firstErr.response?.data?.error?.code
        if (errCode === 'json_validate_failed') {
          console.warn(`Groq json_object mode failed for model ${model}, retrying in free-text mode...`)
          try {
            return await makeRequest(false)
          } catch (retryErr) {
            lastError = retryErr
          }
        } else if (errCode === 'model_not_found') {
          console.warn(`Groq model ${model} not found or decommissioned, trying next fallback model...`)
          continue
        } else {
          // If invalid_request_error, try free-text mode as fallback
          if (firstErr.response?.data?.error?.type === 'invalid_request_error' && errCode !== 'model_not_found') {
            try {
              return await makeRequest(false)
            } catch (retryErr) {
              lastError = retryErr
            }
          }
        }
      }
    }

    throw lastError
  }

  const formattedImage = imageBase64.startsWith('data:image')
    ? imageBase64
    : `data:image/jpeg;base64,${imageBase64}`

  const contentArray = [
    { type: 'text', text: textPrompt },
    { type: 'image_url', image_url: { url: formattedImage } }
  ]

  if (backImageBase64) {
    const formattedBack = backImageBase64.startsWith('data:image')
      ? backImageBase64
      : `data:image/jpeg;base64,${backImageBase64}`
    contentArray.push({ type: 'image_url', image_url: { url: formattedBack } })
  }

  const visionModels = GET_VISION_MODELS()
  let lastVisionError = null

  for (const model of visionModels) {
    const makeVisionRequest = (withFormat) => withGroqKeyRotation((key) => {
      const body = {
        model,
        messages: [{ role: 'user', content: contentArray }],
        temperature: 0.1,
        max_completion_tokens: 2048,
        max_tokens: 2048
      }
      if (withFormat) body.response_format = { type: 'json_object' }
      return axios.post('https://api.groq.com/openai/v1/chat/completions', body, {
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
      })
    })

    try {
      return await makeVisionRequest(true)
    } catch (firstErr) {
      lastVisionError = firstErr
      const errCode = firstErr.response?.data?.error?.code
      if (errCode === 'json_validate_failed') {
        console.warn(`Groq json_object mode failed for vision model ${model}, retrying in free-text mode...`)
        try {
          return await makeVisionRequest(false)
        } catch (retryErr) {
          lastVisionError = retryErr
        }
      } else if (errCode === 'model_not_found') {
        console.warn(`Groq vision model ${model} not found or decommissioned, trying next fallback model...`)
        continue
      } else {
        if (firstErr.response?.data?.error?.type === 'invalid_request_error' && errCode !== 'model_not_found') {
          try {
            return await makeVisionRequest(false)
          } catch (retryErr) {
            lastVisionError = retryErr
          }
        }
      }
    }
  }

  throw lastVisionError
}

const processOcrRequest = async (req, res, promptText, jsonTemplate, postProcessor = null) => {
  try {
    const { imageBase64, backImageBase64 } = req.body

    if (!imageBase64) {
      return res.status(400).json({ success: false, message: 'Document base64 string is required' })
    }

    let isPdf = false
    let payload = imageBase64

    if (imageBase64.startsWith('data:application/pdf')) {
      isPdf = true
      const base64Data = imageBase64.replace(/^data:application\/pdf;base64,/, '')
      const buffer = Buffer.from(base64Data, 'base64')
      const pdfData = await parsePdfWithFallback(buffer)
      const extractedText = extractRelevantPdfText(pdfData.text)

      if (extractedText.trim().length < 100) {
        console.warn('PDF appears to be scanned (image-only) — no text extracted. Pages:', pdfData.numpages)
        return res.status(422).json({
          success: false,
          message: 'This PDF appears to be a scanned image. Please convert it to a text-based PDF or upload a photo of the document instead.',
          isScannedPdf: true
        })
      }

      payload = extractedText
    }

    const fullPrompt = `${promptText}
Respond ONLY with a valid JSON object matching this structure exactly (use empty string "" if a field is not found):
${jsonTemplate}`

    const response = await callGroqAPI(payload, fullPrompt, isPdf, backImageBase64)
    const choiceMsg = response.data.choices?.[0]?.message
    let messageContent = choiceMsg?.content || choiceMsg?.reasoning || ''

    messageContent = messageContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

    let jsonStr = messageContent
    const fencedMatch = messageContent.match(/```(?:json)?\n([\s\S]*?)\n```/) || messageContent.match(/```(?:json)?([\s\S]*?)```/)
    if (fencedMatch) {
      jsonStr = fencedMatch[1].trim()
    } else {
      const objectMatch = messageContent.match(/\{[\s\S]*\}/)
      if (objectMatch) {
        jsonStr = objectMatch[0]
      }
    }

    let extractedData = {}
    try {
      extractedData = JSON.parse(jsonStr)
    } catch (_parseError) {
      console.error('Failed to parse Groq response to JSON:', jsonStr)
      return res.status(500).json({
        success: false,
        message: 'Failed to parse AI response into valid format',
        rawResponse: messageContent,
      })
    }

    if (typeof extractedData.vehicleNumber === 'string') {
      extractedData.vehicleNumber = extractedData.vehicleNumber.replace(/[\s-]/g, '')
    }
    if (typeof extractedData.registrationNumber === 'string') {
      extractedData.registrationNumber = extractedData.registrationNumber.replace(/[\s-]/g, '')
    }

    if (extractedData.insuranceCompany) {
      const companies = await InsuranceCompany.find().select('name').lean();

      const cleanStr = (str) => {
        return (str || '')
          .trim()
          .replace(/[-\/]/g, ' ') // replace hyphens and slashes with space
          .replace(/[^a-zA-Z0-9\s]/g, '') // remove special characters
          .replace(/\s+/g, ' ') // collapse multiple spaces
          .toLowerCase();
      };

      const cleaned = cleanStr(extractedData.insuranceCompany);

      // 1. Exact substring match
      let match = companies.find(c => {
        const cCleaned = cleanStr(c.name);
        return cleaned.includes(cCleaned) || cCleaned.includes(cleaned);
      });

      // 2. Word-overlap scoring fallback
      if (!match) {
        const ocrWords = new Set(cleaned.split(/\s+/).filter(w => w.length > 2));
        const stopwords = new Set(['general', 'insurance', 'company', 'limited', 'ltd', 'services', 'co']);
        const filteredOcrWords = new Set([...ocrWords].filter(w => !stopwords.has(w)));

        let bestMatch = null;
        let bestScore = 0;

        for (const c of companies) {
          const cCleaned = cleanStr(c.name);
          const cWords = cCleaned.split(/\s+/).filter(w => w.length > 2);
          const filteredCWords = cWords.filter(w => !stopwords.has(w));

          if (filteredCWords.length === 0) continue;

          const overlap = filteredCWords.filter(w => filteredOcrWords.has(w)).length;
          const score = overlap / filteredCWords.length;
          if (overlap >= 1 && score > bestScore) {
            bestScore = score;
            bestMatch = c;
          }
        }
        match = bestMatch;
      }

      extractedData.insuranceCompany = match?.name || '';
    }

    // Run any caller-supplied post-processor (e.g. IFFCO Tokio policy# correction)
    if (typeof postProcessor === 'function') {
      extractedData = postProcessor(extractedData) || extractedData
    }

    return res.json({
      success: true,
      data: extractedData,
    })
  } catch (error) {
    console.error('OCR Error:', error.response?.data || error.message)
    return res.status(500).json({
      success: false,
      message: 'Failed to extract document data',
      error: error.response?.data || error.message,
    })
  }
}

const rcOcr = async (req, res) => {
  const prompt = 'Extract the details from this vehicle registration certificate (RC).'
  const template = `{
  "registrationNumber": "",
  "dateOfRegistration": "",
  "chassisNumber": "",
  "engineNumber": "",
  "ownerName": "",
  "sonWifeDaughterOf": "",
  "address": "",
  "makerName": "",
  "makerModel": "",
  "colour": "",
  "seatingCapacity": "",
  "vehicleType": "",
  "ladenWeight": "",
  "unladenWeight": "",
  "manufactureYear": "",
  "vehicleCategory": "",
  "numberOfCylinders": "",
  "cubicCapacity": "",
  "fuelType": "",
  "bodyType": "",
  "wheelBase": ""
}`
  return processOcrRequest(req, res, prompt, template)
}

const taxOcr = async (req, res) => {
  const prompt = 'Extract the details from this vehicle tax receipt/document. DO NOT extract or pick up the tax amount, fine, or total paid. Leave them blank.'
  const template = `{
  "vehicleNumber": "",
  "ownerName": "",
  "taxFrom": "",
  "taxTo": ""
}`
  return processOcrRequest(req, res, prompt, template)
}

const fitnessOcr = async (req, res) => {
  const prompt = 'Extract the details from this vehicle fitness certificate/document. DO NOT extract or pick up the tax amount, fine, or total paid. Leave them blank.'
  const template = `{
  "vehicleNumber": "",
  "ownerName": "",
  "validFrom": "",
  "validTo": ""
}`
  return processOcrRequest(req, res, prompt, template)
}

const pucOcr = async (req, res) => {
  const prompt = 'Extract the details from this vehicle PUC certificate/document. Extract vehicle number, owner name, valid from date, and valid to date only.'
  const template = `{
  "vehicleNumber": "",
  "ownerName": "",
  "validFrom": "",
  "validTo": ""
}`
  return processOcrRequest(req, res, prompt, template)
}

const gpsOcr = async (req, res) => {
  const prompt = 'Extract the details from this vehicle GPS or VLTD fitment certificate/document. Extract vehicle number, owner name, valid from date, and valid to date only. Map "VLTD Fitment Date" to "validFrom". Map "Valid Upto" or "Valid Up to" to "validTo". Preserve the actual date value even when it appears in formats like "03 Apr 2026" or "Mon Apr 03 06:09:38 UTC 2028". Do not invent dates.'
  const template = `{
  "vehicleNumber": "",
  "ownerName": "",
  "validFrom": "",
  "validTo": ""
}`
  return processOcrRequest(req, res, prompt, template)
}

const insuranceOcr = async (req, res) => {
  const prompt = `Extract fields from this vehicle insurance policy document.
- vehicleNumber: the vehicle registration number — EXACTLY 9 or 10 characters after removing hyphens/spaces (format: 2 state letters + 2 district digits + 1-3 series letters + 4 digits, e.g. MH12AB1234, DL01CA9999). Remove hyphens/spaces. Do NOT return engine numbers, chassis numbers, or any value longer than 10 characters. CRITICAL: If the document says "NEW" / "UNREGISTERED" / "APPLIED FOR" / "NOT REGISTERED" / "TO BE REGISTERED" or if the vehicle is new and has no registration mark yet, leave vehicleNumber as empty string "". Do NOT pick up engine numbers or chassis numbers as vehicleNumber!
- policyNumber: the OFFICIAL policy number issued by the insurer. IMPORTANT: Some documents (e.g. IFFCO Tokio) show TWO "Policy #" values on the same line — the first is an internal transaction/invoice reference (often starts with "1-" or looks like "1-XXXXXXXX"), and the SECOND is the actual policy number. Always use the LAST/SECOND "Policy #" value as the policyNumber. The "Tax Invoice No" field is NOT the policy number. CRITICAL for Go Digit policies: Go Digit prints the real policy number in the format "D[9 digits] / [DDMMYYYY]" (e.g. "D282367063 / 28072026") — use the FULL string including the " / DDMMYYYY" part as policyNumber. Go Digit also shows an Invoice Number starting with "IA" (e.g. "IA278149378") — this is NOT the policy number, NEVER use the IA-prefixed number as policyNumber.
- policyHolderName: primary insured person/company name
- validFrom / validTo: the main policy period (Own Damage section if present, otherwise overall policy period). DD-MM-YYYY format.
- tpValidFrom / tpValidTo: the Third Party / Act Liability cover period. Many long-term two-wheeler/private-car policies have a separate, longer TP validity period than the OD period (e.g. OD valid for 1 year but TP valid for 5 years) — look for a distinct "Third Party" or "Liability" or "Act" section with its own "Period of Insurance" / "From" / "To" dates. If the document has only one policy period (no separate TP period), leave tpValidFrom/tpValidTo as empty strings. DD-MM-YYYY format.
- issueDate: the date the policy document was issued or receipt date. Look for "Policy Issue Date", "Date of Issue", "Invoice Date", "Receipt Date", "Reciept Date", "Collection Date", "Proposal Date", "Policy Date", "Issue Date". Format: DD-MM-YYYY.
- odPremium: numeric value of the "Total OD Premium" (own damage), the FINAL own-damage figure AFTER NCB discount is applied. IMPORTANT: many policies (e.g. Digit, ICICI Lombard) show a table with an intermediate "Own Damage Premium" subtotal (before NCB discount) plus a separate "NCB (xx%)" deduction line, and then a "Total OD Premium" line which is the final figure (Own Damage Premium minus NCB) — you MUST use the "Total OD Premium" value, NOT the intermediate "Own Damage Premium" subtotal. Do NOT use the Final/Gross Premium value here even if it appears near this section. Empty string if the policy has no OD component (Third Party only policy).
- tpPremium: numeric value of the "Total Act Premium" / "Total Liability Premium" / "Total TP Premium" — the final total of the Liability/Act premium section (Basic Third-Party Liability + Legal Liability add-ons + PA cover add-ons, if any). If the document has no separate add-ons, this equals "Basic Third-Party Liability". Do NOT use the Final/Gross Premium value here. CRITICAL: If the document is a "Standalone OD" / "Own Damage Only" policy, or if Liability Premium is 0 or blank, leave tpPremium as empty string "". NEVER put GST/Tax (such as 18% tax = 168) as tpPremium!
- netPremium: numeric value labeled exactly "Net Premium" or "Total Premium (a+b)" — this is odPremium + tpPremium (before GST/taxes). It is a DISTINCT, smaller number than the Final/Gross Premium — do not confuse the two.
- premium: numeric value of the Gross Premium — labeled "Final Premium" or "Gross Premium", the LARGEST of the four premium figures, equal to Net Premium + GST/CGST+SGST/IGST (roughly netPremium × 1.18). Return the exact decimal value including paise/cents if present (e.g., 1182.71). Do not omit the decimal or round. If only one premium figure exists on the document (no OD/TP/Net split), put that value here as premium and leave odPremium/tpPremium/netPremium empty.
- SELF-CHECK before answering: odPremium + tpPremium should be close to netPremium (within a few rupees, allowing for small add-ons), and netPremium should be meaningfully smaller than premium (premium ≈ netPremium × 1.18 for 18% GST). If your extracted values don't satisfy this, re-examine the document for the correct "Total OD Premium" / "Total Act Premium" / "Net Premium" / "Final Premium" labels rather than reusing the same number for multiple fields.
- insuranceCompany: full insurer name as it appears (e.g. "HDFC ERGO", "National Insurance Company Limited")
- insuranceClass: "Comprehensive" or "Third Party" or "Standalone OD" or "Bundle" (if not found, infer from policy type)
- product: type of insured vehicle/policy. Look for phrases like "Private Car", "Motor Cycle", "Two Wheeler", "Fire", "Marine", "Health" etc. in the document, and map to EXACTLY one of these values (return the value on the left, verbatim): "Pvt. Car" (private car / motor car), "Two Wheeler" (motorcycle/scooter/bike/two-wheeler), "GCV" (goods carrying vehicle/truck/commercial goods vehicle), "GCV-3W" (3-wheeler goods vehicle), "PCV" (passenger carrying vehicle/bus), "PCV-3W" (3-wheeler passenger/auto rickshaw), "Taxi", "Mis-D", "Health", "Life", "Fire", "Burglary", "WC" (workmen's compensation), "CPM", "Travel", "Marine", "GPA" (group personal accident), "GMC" (group mediclaim), "CAR", "IAR", "EAR", "SCHOOL BUS", "LIABILITY", "SECURITY BOND". If none match, return empty string.
- Use empty string "" for any absent field`;
  const template = `{"vehicleNumber":"","policyNumber":"","policyHolderName":"","validFrom":"","validTo":"","tpValidFrom":"","tpValidTo":"","issueDate":"","odPremium":"","tpPremium":"","netPremium":"","premium":"","insuranceCompany":"","insuranceClass":"","product":""}`;

  // Store raw PDF text for post-processing override (IFFCO Tokio and similar)
  req._rawPdfText = null
  if (req.body.imageBase64?.startsWith('data:application/pdf')) {
    try {
      const base64Data = req.body.imageBase64.replace(/^data:application\/pdf;base64,/, '')
      const buffer = Buffer.from(base64Data, 'base64')
      const pdfData = await parsePdfWithFallback(buffer)
      req._rawPdfText = pdfData.text
    } catch (_) { /* ignore, will fall back to AI result */ }
  }

  return processOcrRequest(req, res, prompt, template, (extractedData) => {
    if (req._rawPdfText) {
      // 1. Fix IFFCO Tokio dual-Policy# line — pick the actual (last) policy number
      const correctedPolicyNo = extractIffcoTokioPolicyNumber(req._rawPdfText)
      if (correctedPolicyNo) {
        extractedData.policyNumber = correctedPolicyNo
      }

      // 1b. Fix Go Digit policy number — Go Digit PDFs print the real policy number
      //     (D-prefix + 9 digits) concatenated with the issue date as:
      //       "D282367063 / 28072026"
      //     pdf-parse includes this line verbatim, but the AI often grabs the
      //     Invoice Number (IA-prefix, e.g. IA278149378) instead of the real policy number.
      //     We scan the raw text for the "D[digits] / [8-digit date]" pattern and override.
      if (/go.?digit/i.test(req._rawPdfText) || /\bD\d{9}\s*\/\s*\d{8}\b/.test(req._rawPdfText)) {
        const digitPolicyMatch = req._rawPdfText.match(/\b(D\d{7,12}\s*\/\s*\d{6,8})\b/)
        if (digitPolicyMatch) {
          const realPolicyNo = digitPolicyMatch[1].trim()
          if (realPolicyNo !== extractedData.policyNumber) {
            console.log('[GoDigit] Overriding policyNumber:', extractedData.policyNumber, '->', realPolicyNo)
            extractedData.policyNumber = realPolicyNo
          }
        }
      }
      // 2. Fix vehicle number — Indian reg nos are 9-10 chars.
      //    If document indicates a NEW / Unregistered vehicle, set to "".
      //    Otherwise if the AI returned something clearly wrong (too long or invalid pattern),
      //    scan the raw PDF text for the correct registration number.
      const currentVehicle = (extractedData.vehicleNumber || '').replace(/[\s-]/g, '')
      if (isNewVehicleRegistration(req._rawPdfText, currentVehicle)) {
        console.log('[VehicleNo] New/Unregistered vehicle detected. Setting vehicleNumber to empty string.')
        extractedData.vehicleNumber = ''
      } else if (!isValidIndianVehicleNumber(currentVehicle)) {
        const correctedVehicleNo = extractValidIndianVehicleNumber(req._rawPdfText)
        if (correctedVehicleNo !== null && correctedVehicleNo !== undefined) {
          console.log('[VehicleNo] Overriding', currentVehicle, '->', correctedVehicleNo)
          extractedData.vehicleNumber = correctedVehicleNo
        }
      }

      // 3. Fix Net Premium / Gross Premium using the clean ENDORSEMENT invoice
      //    table (Go Digit and similar) — this table is unambiguous, unlike
      //    the OD/TP breakdown table which pdf-parse often scrambles.
      const endorsementPremiums = extractNetGrossPremiumFromEndorsementTable(req._rawPdfText)
      if (endorsementPremiums) {
        console.log('[Premium] Overriding netPremium/premium from ENDORSEMENT table:', endorsementPremiums)
        extractedData.netPremium = endorsementPremiums.netPremium
        extractedData.premium = endorsementPremiums.premium
      }

      // 4. Fix OD/TP premium split for Go Digit-style scrambled breakdown tables
      const knownNetPremium = endorsementPremiums?.netPremium ?? (extractedData.netPremium ? Number(extractedData.netPremium) : null)
      const digitOdTp = extractDigitOdTpPremium(req._rawPdfText, knownNetPremium)
      if (digitOdTp) {
        console.log('[Premium] Overriding odPremium/tpPremium from Go Digit summary row:', digitOdTp)
        extractedData.odPremium = digitOdTp.odPremium
        extractedData.tpPremium = digitOdTp.tpPremium
      }

      // 5. Fix Gross Premium for Bajaj Allianz policies.
      //    Bajaj's two-column layout (OD|Liability) causes pdf-parse to
      //    interleave the columns, making the AI pick up the Net Premium
      //    value as the Gross Premium. We override "premium" with the
      //    unambiguous "Final Premium Rs.XXX" line extracted directly.
      //    Only apply this when the ENDORSEMENT table correction hasn't
      //    already fixed it (to avoid double-overriding).
      if (!endorsementPremiums) {
        const bajajPremiums = extractBajajFinalPremium(req._rawPdfText)
        if (bajajPremiums) {
          const currentPremium = extractedData.premium ? Number(extractedData.premium) : null
          // Only override if the AI got the gross premium wrong (same as net, or clearly off)
          const aiGotWrongGross = currentPremium == null ||
            currentPremium === bajajPremiums.netPremium ||
            (bajajPremiums.netPremium != null && Math.abs(currentPremium - bajajPremiums.netPremium) < 2)
          if (aiGotWrongGross) {
            console.log('[Bajaj] Overriding premium:', currentPremium, '->', bajajPremiums.finalPremium)
            extractedData.premium = bajajPremiums.finalPremium
          }
          // Also correct netPremium if the AI left it blank or set it to the gross value
          if (bajajPremiums.netPremium != null) {
            const currentNet = extractedData.netPremium ? Number(extractedData.netPremium) : null
            const netIsWrong = currentNet == null ||
              Math.abs(currentNet - bajajPremiums.finalPremium) < 2 // AI set net = gross
            if (netIsWrong) {
              console.log('[Bajaj] Overriding netPremium:', currentNet, '->', bajajPremiums.netPremium)
              extractedData.netPremium = bajajPremiums.netPremium
            }
          }
        }
      }

      // 6. Fix policy dates for Go Digit PDFs.
      //    Go Digit flattens a two-column date table (OD | TP) into 4
      //    consecutive date strings: [OD-From, TP-From, OD-To, TP-To].
      //    The page also contains a line like "D262115781 / 11042026"
      //    (policy number + issue date concatenated) which the AI mistakes
      //    for the validFrom date ("11-04-2026") instead of the correct
      //    "12-04-2026" that comes from the Period-of-Policy table.
      //    We extract dates directly from the Period-of-Policy block and
      //    override only when the AI's value differs from the table value.
      const digitDates = extractDigitPolicyDates(req._rawPdfText)
      if (digitDates) {
        // Override validFrom if it differs from what the table says
        if (digitDates.validFrom && digitDates.validFrom !== extractedData.validFrom) {
          console.log('[GoDigit] Overriding validFrom:', extractedData.validFrom, '->', digitDates.validFrom)
          extractedData.validFrom = digitDates.validFrom
        }
        if (digitDates.validTo && digitDates.validTo !== extractedData.validTo) {
          console.log('[GoDigit] Overriding validTo:', extractedData.validTo, '->', digitDates.validTo)
          extractedData.validTo = digitDates.validTo
        }
        if (digitDates.tpValidFrom && digitDates.tpValidFrom !== extractedData.tpValidFrom) {
          console.log('[GoDigit] Overriding tpValidFrom:', extractedData.tpValidFrom, '->', digitDates.tpValidFrom)
          extractedData.tpValidFrom = digitDates.tpValidFrom
        }
        if (digitDates.tpValidTo && digitDates.tpValidTo !== extractedData.tpValidTo) {
          console.log('[GoDigit] Overriding tpValidTo:', extractedData.tpValidTo, '->', digitDates.tpValidTo)
          extractedData.tpValidTo = digitDates.tpValidTo
        }
      }

      // 7. Fix premiums for HDFC ERGO policies (especially Standalone OD)
      const hdfcPremiums = extractHdfcErgoPremiums(req._rawPdfText)
      if (hdfcPremiums) {
        if (hdfcPremiums.isStandaloneOd) {
          extractedData.tpPremium = ''
          extractedData.tpValidFrom = ''
          extractedData.tpValidTo = ''
          if (!extractedData.insuranceClass || extractedData.insuranceClass === 'Comprehensive') {
            extractedData.insuranceClass = 'Standalone OD'
          }
        }
        if (hdfcPremiums.odPremium != null) extractedData.odPremium = hdfcPremiums.odPremium
        if (hdfcPremiums.tpPremium !== null && hdfcPremiums.tpPremium !== undefined) extractedData.tpPremium = hdfcPremiums.tpPremium
        if (hdfcPremiums.netPremium != null) extractedData.netPremium = hdfcPremiums.netPremium
        if (hdfcPremiums.premium != null) extractedData.premium = hdfcPremiums.premium
      }

      // 8. General tax misclassification guard:
      // If tpPremium is present, and premium (gross) and (netPremium or odPremium) exist:
      // Tax = premium - netPremium. If tpPremium matches Tax (e.g. tpPremium == 168 and premium - netPremium == 168),
      // or if odPremium == netPremium and odPremium + tpPremium == premium (gross),
      // then tpPremium is actually the GST/Tax figure! Clear tpPremium = '' and set netPremium = odPremium.
      if (extractedData.tpPremium && extractedData.premium && (extractedData.netPremium || extractedData.odPremium)) {
        const gross = Number(extractedData.premium)
        const tp = Number(extractedData.tpPremium)
        const od = extractedData.odPremium ? Number(extractedData.odPremium) : null
        const net = extractedData.netPremium ? Number(extractedData.netPremium) : od

        if (gross && tp && net && gross > net) {
          const tax = Math.round(gross - net)
          if (Math.abs(tp - tax) <= 2 || (od != null && Math.abs(od - net) <= 2 && Math.abs(od + tp - gross) <= 2)) {
            console.log('[TaxGuard] tpPremium', tp, 'matches Tax (gross - net =', tax, '). Clearing misclassified tpPremium.')
            extractedData.tpPremium = ''
            if (od != null) extractedData.netPremium = od
          }
        }
      }

      // 9. Fix premiums and reference TP dates for IFFCO Tokio
      const iffcoPremiums = extractIffcoTokioPremiums(req._rawPdfText)
      if (iffcoPremiums) {
        if (iffcoPremiums.isStandaloneOd) {
          extractedData.tpPremium = ''
          extractedData.tpValidFrom = ''
          extractedData.tpValidTo = ''
          extractedData.insuranceClass = 'Standalone OD'
        }
        if (iffcoPremiums.odPremium != null) extractedData.odPremium = iffcoPremiums.odPremium
        if (iffcoPremiums.netPremium != null) extractedData.netPremium = iffcoPremiums.netPremium
        if (iffcoPremiums.premium != null) extractedData.premium = iffcoPremiums.premium
      }

      // 10. General Guard for External Reference TP policies across ALL insurers:
      // If TP Insurer Name is present and refers to a DIFFERENT insurer than current insurer,
      // clear tpValidFrom, tpValidTo, and tpPremium!
      const tpInsurerMatch = req._rawPdfText.match(/TP\s*Insurer\s*Name\s*:\s*([^\n]+)/i)
        || req._rawPdfText.match(/Third\s*Party\s*Insurer\s*:\s*([^\n]+)/i)
      if (tpInsurerMatch) {
        const tpInsurer = tpInsurerMatch[1].trim().toLowerCase()
        const currentComp = (extractedData.insuranceCompany || '').toLowerCase()
        const cleanTp = tpInsurer.replace(/[^a-z0-9]/g, '')
        const cleanCur = currentComp.replace(/[^a-z0-9]/g, '')
        if (cleanTp && cleanCur && !cleanTp.includes(cleanCur) && !cleanCur.includes(cleanTp)) {
          console.log('[ExternalTPGuard] Reference TP policy from external insurer (' + tpInsurerMatch[1].trim() + '). Clearing TP dates & TP premium.')
          extractedData.tpValidFrom = ''
          extractedData.tpValidTo = ''
          extractedData.tpPremium = ''
          if (!extractedData.insuranceClass || extractedData.insuranceClass === 'Comprehensive') {
            extractedData.insuranceClass = 'Standalone OD'
          }
        }
      }

      // 11. Fix premiums and class for National Insurance Company (NIC) policies.
      //     NIC PDFs often have a two-column premium table that pdf-parse
      //     scrambles. We extract directly from the raw text.
      const nicPremiums = extractNationalInsurancePremiums(req._rawPdfText)
      if (nicPremiums) {
        extractedData.insuranceClass = nicPremiums.insuranceClass
        if (nicPremiums.odPremium != null) extractedData.odPremium = String(nicPremiums.odPremium)
        else extractedData.odPremium = ''
        if (nicPremiums.tpPremium != null) extractedData.tpPremium = String(nicPremiums.tpPremium)
        if (nicPremiums.netPremium != null) extractedData.netPremium = String(nicPremiums.netPremium)
        if (nicPremiums.premium != null) extractedData.premium = String(nicPremiums.premium)
        // For Third Party only policies, clear OD dates
        if (nicPremiums.insuranceClass === 'Third Party') {
          extractedData.tpValidFrom = extractedData.tpValidFrom || extractedData.validFrom
          extractedData.tpValidTo = extractedData.tpValidTo || extractedData.validTo
        }
      }

      // 12. Fix premiums for Royal Sundaram policies.
      //     Royal Sundaram PDFs are multi-page; the segment scorer often
      //     selects marketing/info pages and the AI never sees the premium
      //     breakdown. We extract OD/TP/Net/Gross directly from raw text.
      const rsPremiums = extractRoyalSundaramPremiums(req._rawPdfText)
      if (rsPremiums) {
        if (rsPremiums.odPremium != null) extractedData.odPremium = String(rsPremiums.odPremium)
        if (rsPremiums.tpPremium != null) extractedData.tpPremium = String(rsPremiums.tpPremium)
        if (rsPremiums.netPremium != null) extractedData.netPremium = String(rsPremiums.netPremium)
        if (rsPremiums.premium != null) extractedData.premium = String(rsPremiums.premium)
      }

      // 13. Fix issueDate — AI sometimes hallucinates today's date or picks
      //     the wrong date (e.g. policy start instead of issue date).
      //     We read "Invoice Date", "Issue Date", "Policy Issue Date" etc.
      //     directly from the raw PDF text and override only when the raw
      //     text clearly provides a value.
      const rawIssueDate = extractIssueDateFromRawText(req._rawPdfText)
      if (rawIssueDate && rawIssueDate !== extractedData.issueDate) {
        console.log('[IssueDate] Overriding issueDate:', extractedData.issueDate, '->', rawIssueDate)
        extractedData.issueDate = rawIssueDate
      }
    }
    return extractedData
  })
}

module.exports = {
  rcOcr,
  taxOcr,
  fitnessOcr,
  pucOcr,
  gpsOcr,
  insuranceOcr,
}
