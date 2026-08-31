/** @typedef {{ tel: string; telExt: string }} ParsedPhone */

const PHONE_MAIN_MIN_DIGITS = 8;
const PHONE_MAIN_MAX_DIGITS = 10;
const PHONE_EXT_MAX_DIGITS = 6;
const PHONE_CONTRACT_MAIN_MIN = 9;
const PHONE_CONTRACT_MAIN_MAX = 15;

/**
 * Parse phone line from DB/import — supports:
 * - 0812345678
 * - 034130700-51000 (main-ext)
 * - 034130700-5#1000 (landline + dial prefix + #extension)
 * - 034130700#1000
 * @param {string} line
 * @returns {ParsedPhone}
 */
function parseTelLineFromDb(line) {
  let t = String(line ?? '').trim().replace(/\s+/g, '');
  if (!t) return { tel: '', telExt: '' };

  const hashIdx = t.indexOf('#');
  if (hashIdx >= 0) {
    const afterHash = t.slice(hashIdx + 1).replace(/\D/g, '').slice(0, PHONE_EXT_MAX_DIGITS);
    const before = t.slice(0, hashIdx).trim();
    const dashMatch = before.match(/^(\d{9,15})-(\d{1,6})$/);
    if (dashMatch) {
      const main = dashMatch[1];
      const prefix = dashMatch[2];
      const ext = (prefix + afterHash).slice(0, PHONE_EXT_MAX_DIGITS);
      return { tel: main, telExt: ext };
    }
    const mainDigits = before.replace(/\D/g, '');
    if (mainDigits.length >= PHONE_CONTRACT_MAIN_MIN && mainDigits.length <= PHONE_CONTRACT_MAIN_MAX) {
      return { tel: mainDigits, telExt: afterHash };
    }
  }

  let m = t.match(/^(\d{10})-(\d{1,6})$/);
  if (m) return { tel: m[1], telExt: m[2] };
  m = t.match(/^(\d{9,15})-(\d{1,6})$/);
  if (m) return { tel: m[1], telExt: m[2] };

  // Display format: "034-130-700 - 51000"
  const displayExt = t.match(/^(.+?)\s+-\s+(\d{1,6})$/);
  if (displayExt) {
    const mainDigits = displayExt[1].replace(/\D/g, '');
    const ext = displayExt[2];
    if (mainDigits.length >= PHONE_CONTRACT_MAIN_MIN && mainDigits.length <= PHONE_CONTRACT_MAIN_MAX) {
      return { tel: mainDigits, telExt: ext };
    }
  }

  const digits = t.replace(/\D/g, '');
  if (!digits) return { tel: '', telExt: '' };
  if (digits.length <= PHONE_MAIN_MAX_DIGITS) return { tel: digits, telExt: '' };
  return {
    tel: digits.slice(0, PHONE_MAIN_MAX_DIGITS),
    telExt: digits.slice(PHONE_MAIN_MAX_DIGITS, PHONE_MAIN_MAX_DIGITS + PHONE_EXT_MAX_DIGITS),
  };
}

/**
 * @param {string} tel
 * @param {string} telExt
 * @returns {string}
 */
function formatTelLineForDb(tel, telExt) {
  const m = String(tel ?? '').replace(/\D/g, '');
  const x = String(telExt ?? '').replace(/\D/g, '').slice(0, PHONE_EXT_MAX_DIGITS);
  if (!m && !x) return '';
  if (m && x) return `${m}-${x}`;
  return m;
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function looksLikePhoneLine(line) {
  const t = String(line ?? '').trim();
  if (!t) return false;
  const parsed = parseTelLineFromDb(t);
  if (!parsed.tel) return false;
  const mainLen = parsed.tel.length;
  return mainLen >= PHONE_CONTRACT_MAIN_MIN && mainLen <= PHONE_CONTRACT_MAIN_MAX;
}

module.exports = {
  PHONE_MAIN_MIN_DIGITS,
  PHONE_MAIN_MAX_DIGITS,
  PHONE_EXT_MAX_DIGITS,
  parseTelLineFromDb,
  formatTelLineForDb,
  looksLikePhoneLine,
};
