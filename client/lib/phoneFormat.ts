/**
 * Employee phone: ช่องหลัก 8–10 หลัก แสดงเป็น xxx-xxx-xxxx (ใส่ - อัตโนมัติ)
 * ต่อ (Ext) สูงสุด 6 หลัก — บันทึกเป็น mainDigits-ext เช่น 0123456789-123456
 */

/** จำนวนหลักขั้นต่ำ / สูงสุด — ใช้ร่วมกับแจ้งเตือนใน UI */
export const PHONE_MAIN_MIN_DIGITS = 8;
export const PHONE_MAIN_MAX_DIGITS = 10;
export const PHONE_EXT_MAX_DIGITS = 6;

const MAIN_MIN = PHONE_MAIN_MIN_DIGITS;
const MAIN_LEN = PHONE_MAIN_MAX_DIGITS;
const EXT_MAX = PHONE_EXT_MAX_DIGITS;

/** แสดงเบอร์สูงสุด 10 หลักแบบ xxx-xxx-xxxx จาก input ใดๆ */
export function formatTenDigitUsDisplay(raw: string): string {
  const d = raw.replace(/\D/g, '').slice(0, MAIN_LEN);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
}

export function parseTelLineFromDb(line: string): { tel: string; telExt: string } {
  const t = String(line ?? '').trim().replace(/\s+/g, '');
  if (!t) return { tel: '', telExt: '' };

  const hashIdx = t.indexOf('#');
  if (hashIdx >= 0) {
    const afterHash = t.slice(hashIdx + 1).replace(/\D/g, '').slice(0, EXT_MAX);
    const before = t.slice(0, hashIdx).trim();
    const dashMatch = before.match(/^(\d{9,15})-(\d{1,6})$/);
    if (dashMatch) {
      const main = dashMatch[1];
      const prefix = dashMatch[2];
      const ext = (prefix + afterHash).slice(0, EXT_MAX);
      return { tel: main, telExt: ext };
    }
    const mainDigits = before.replace(/\D/g, '');
    if (mainDigits.length >= 9 && mainDigits.length <= 15) {
      return { tel: mainDigits, telExt: afterHash };
    }
  }

  // Display format: "034-130-700 - 51000" or "081-234-5678 - 123"
  const displayExt = t.match(/^(.+?)\s+-\s+(\d{1,6})$/);
  if (displayExt) {
    const mainDigits = displayExt[1].replace(/\D/g, '');
    const ext = displayExt[2];
    if (mainDigits.length >= 9 && mainDigits.length <= 15) {
      return { tel: mainDigits, telExt: ext };
    }
  }

  // 10 หลัก + ต่อ
  let m = t.match(/^(\d{10})-(\d{1,6})$/);
  if (m) return { tel: m[1], telExt: m[2] };
  // รูปแบบ contract เดิม: 9–15 หลัก + ต่อ
  m = t.match(/^(\d{9,15})-(\d{1,6})$/);
  if (m) return { tel: m[1], telExt: m[2] };
  const digits = t.replace(/\D/g, '');
  if (!digits) return { tel: '', telExt: '' };
  if (digits.length <= MAIN_LEN) return { tel: digits, telExt: '' };
  return { tel: digits.slice(0, MAIN_LEN), telExt: digits.slice(MAIN_LEN, MAIN_LEN + EXT_MAX) };
}

export function formatTelLineForDb(tel: string, telExt: string): string {
  const m = tel.replace(/\D/g, '').slice(0, MAIN_LEN);
  const x = telExt.replace(/\D/g, '').slice(0, EXT_MAX);
  if (!m && !x) return '';
  if (m && x) return `${m}-${x}`;
  return m;
}

/** บันทึกเบอร์ contract/site contact — หลัก 9–15 หลัก + ext */
export function formatContractTelLineForDb(tel: string, telExt: string): string {
  const m = tel.replace(/\D/g, '');
  const x = telExt.replace(/\D/g, '').slice(0, EXT_MAX);
  if (!m && !x) return '';
  if (m && x) return `${m}-${x}`;
  return m;
}

/** ตรวจเบอร์ contract/site contact (ไม่บังคับ) — หลัก 9–15 หลัก */
export function validateOptionalContractPhoneLine(line: string): string {
  const p = parseTelLineFromDb(String(line ?? '').trim());
  const mainD = p.tel.replace(/\D/g, '');
  const extD = p.telExt.replace(/\D/g, '');
  if (!mainD && !extD) return '';
  if (!mainD) return 'Enter the main number before extension.';
  if (mainD.length < 9 || mainD.length > 15) return 'Phone must be 9–15 digits.';
  if (extD && (extD.length < 1 || extD.length > EXT_MAX)) {
    return 'Extension must be 1–6 digits when provided.';
  }
  return '';
}

/** ระหว่างพิมพ์: แจ้งเมื่อเกิน max หรือมีตัวเลขแล้วน้อยกว่า min */
export function validateEmployeePhoneInline(tel: string, telExt: string): string {
  const mainD = tel.replace(/\D/g, '');
  const extD = telExt.replace(/\D/g, '');
  if (mainD.length > MAIN_LEN) return `Phone must be at most ${MAIN_LEN} digits.`;
  if (mainD.length > 0 && mainD.length < MAIN_MIN) {
    return `Phone must be at least ${MAIN_MIN} digits.`;
  }
  if (extD && (extD.length < 1 || extD.length > EXT_MAX)) {
    return 'Extension must be 1–6 digits when provided.';
  }
  return '';
}

/** เบอร์ไม่บังคับ — ระหว่างพิมพ์ไม่เตือนเรื่องขั้นต่ำ; ตรวจเฉพาะเกิน max / ต่อไม่ถูก */
export function validateOptionalEmployeePhoneInline(tel: string, telExt: string): string {
  const mainD = tel.replace(/\D/g, '');
  const extD = telExt.replace(/\D/g, '');
  if (!mainD && !extD) return '';
  if (mainD.length > MAIN_LEN) return `Phone must be at most ${MAIN_LEN} digits.`;
  if (extD && !mainD) return 'Enter the main number before extension.';
  if (extD && (extD.length < 1 || extD.length > EXT_MAX)) {
    return 'Extension must be 1–6 digits when provided.';
  }
  return '';
}

/** ตอนส่งฟอร์ม / import — เบอร์หลัก 8–10 หลัก */
export function validateEmployeePhoneSubmit(tel: string, telExt: string): string {
  const mainD = tel.replace(/\D/g, '');
  const extD = telExt.replace(/\D/g, '');
  if (!mainD) return 'Phone is required.';
  if (mainD.length < MAIN_MIN) return `Phone must be at least ${MAIN_MIN} digits.`;
  if (mainD.length > MAIN_LEN) return `Phone must be at most ${MAIN_LEN} digits.`;
  if (extD && (extD.length < 1 || extD.length > EXT_MAX)) {
    return 'Extension must be 1–6 digits when provided.';
  }
  return '';
}

/** เบอร์ไม่บังคับ: ว่างทั้งคู่ผ่าน; ถ้ามีตัวเลข — ใช้กฎเดียวกับ validateEmployeePhoneSubmit */
export function validateOptionalEmployeePhoneSubmit(tel: string, telExt: string): string {
  const mainD = tel.replace(/\D/g, '');
  const extD = telExt.replace(/\D/g, '');
  if (!mainD && !extD) return '';
  return validateEmployeePhoneSubmit(tel, telExt);
}

/** @deprecated ใช้ validateEmployeePhoneSubmit หรือ validateEmployeePhoneInline */
export const validateContractStylePhone = validateEmployeePhoneSubmit;

/** แสดงในรายการ: xxx-xxx-xxxx หรือ xxx-xxx-xxxx - ext */
export function formatEmployeeTelForDisplay(line: string): string {
  const p = parseTelLineFromDb(String(line ?? '').trim());
  const d = p.tel.replace(/\D/g, '');
  if (!d) return '';
  const main =
    d.length <= MAIN_LEN
      ? formatTenDigitUsDisplay(p.tel)
      : d.replace(/(\d{3})(\d{3})(\d+)/, '$1-$2-$3');
  if (p.telExt) return `${main} - ${p.telExt}`;
  return main;
}

/** @alias formatEmployeeTelForDisplay — site/contract contact */
export const formatContractTelForDisplay = formatEmployeeTelForDisplay;
