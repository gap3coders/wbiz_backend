const expandScientificNotation = (value = '') => {
  const raw = String(value || '').trim();
  if (!/[eE]/.test(raw)) return raw;
  const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return raw;
  const sign = match[1] || '';
  const intPart = match[2] || '';
  const fracPart = match[3] || '';
  const exponent = Number.parseInt(match[4], 10);
  if (!Number.isFinite(exponent)) return raw;
  const digits = `${intPart}${fracPart}`;
  const decimalPosition = intPart.length + exponent;
  if (decimalPosition <= 0) {
    return `${sign}0.${'0'.repeat(Math.abs(decimalPosition))}${digits}`;
  }
  if (decimalPosition >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  }
  return `${sign}${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
};

const digitsOnly = (value = '') => expandScientificNotation(value).replace(/[^\d]/g, '');

const COUNTRY_CODE_LIST = [
  '1', '7', '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47', '48', '49',
  '52', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
  '211', '212', '213', '216', '218', '220', '221', '223', '224', '225', '226', '227', '228', '229',
  '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243', '244', '245', '248', '249',
  '250', '251', '252', '253', '254', '255', '256', '257', '258', '260', '261', '262', '263', '264', '265', '266', '267', '268', '269',
  '290', '291', '297', '298', '299',
  '351', '352', '353', '354', '355', '356', '357', '358', '359',
  '370', '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382', '383', '385', '386', '387', '389',
  '420', '421', '423',
  '500', '501', '502', '503', '504', '505', '506', '507', '508', '509',
  '590', '591', '592', '593', '594', '595', '596', '597', '598', '599',
  '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689',
  '850', '852', '853', '855', '856', '880', '886',
  '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971', '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996', '998',
];

const SORTED_COUNTRY_CODES = [...COUNTRY_CODE_LIST].sort((a, b) => b.length - a.length);

const normalizeCountryCode = (value = '') => {
  const code = digitsOnly(value);
  if (!code) return '';
  return code.replace(/^0+/, '');
};

const normalizeNationalNumber = (value = '') => digitsOnly(value);

const splitCombinedPhone = (phone = '', fallbackCountryCode = '91') => {
  const combined = digitsOnly(phone);
  if (!combined) {
    return { country_code: '', phone_number: '', phone: '' };
  }

  const matchedCode = SORTED_COUNTRY_CODES.find((code) => combined.startsWith(code));
  if (matchedCode && combined.length > matchedCode.length + 5) {
    return {
      country_code: matchedCode,
      phone_number: combined.slice(matchedCode.length),
      phone: combined,
    };
  }

  const fallback = normalizeCountryCode(fallbackCountryCode);
  if (fallback && combined.length > 5) {
    return {
      country_code: fallback,
      phone_number: combined.startsWith(fallback) ? combined.slice(fallback.length) : combined,
      phone: combined.startsWith(fallback) ? combined : `${fallback}${combined}`,
    };
  }

  return {
    country_code: '',
    phone_number: combined,
    phone: combined,
  };
};

const parsePhoneInput = ({ phone = '', country_code = '', phone_number = '', default_country_code = '91' } = {}) => {
  const rawPhone = String(phone || '').trim();
  const directCountryCode = normalizeCountryCode(country_code);
  const directPhoneNumber = normalizeNationalNumber(phone_number);
  const combined = digitsOnly(phone);
  const hasExplicitIntlPrefix = rawPhone.startsWith('+') || rawPhone.startsWith('00');

  let nextCountryCode = directCountryCode;
  let nextPhoneNumber = directPhoneNumber;
  let nextPhone = '';

  if (nextCountryCode && nextPhoneNumber) {
    nextPhone = `${nextCountryCode}${nextPhoneNumber}`;
  } else if (combined) {
    const fallbackCountryCode = normalizeCountryCode(default_country_code);
    if (!directCountryCode && !directPhoneNumber && !hasExplicitIntlPrefix && fallbackCountryCode) {
      const alreadyWithFallback = combined.startsWith(fallbackCountryCode) && combined.length > fallbackCountryCode.length + 5;
      if (alreadyWithFallback) {
        nextCountryCode = fallbackCountryCode;
        nextPhoneNumber = combined.slice(fallbackCountryCode.length);
        nextPhone = combined;
      } else {
        nextCountryCode = fallbackCountryCode;
        nextPhoneNumber = combined;
        nextPhone = `${fallbackCountryCode}${combined}`;
      }
    } else {
      const split = splitCombinedPhone(combined, default_country_code);
      nextCountryCode = nextCountryCode || split.country_code;
      nextPhoneNumber = nextPhoneNumber || split.phone_number;
      nextPhone = split.phone;
    }
  } else if (nextCountryCode || nextPhoneNumber) {
    nextPhone = `${nextCountryCode}${nextPhoneNumber}`;
  }

  if (!nextCountryCode && nextPhone) {
    const split = splitCombinedPhone(nextPhone, default_country_code);
    nextCountryCode = split.country_code;
    nextPhoneNumber = split.phone_number || nextPhoneNumber;
    nextPhone = split.phone;
  }

  const normalizedPhone = digitsOnly(nextPhone);
  const normalizedCountryCode = normalizeCountryCode(nextCountryCode);
  const normalizedPhoneNumber = normalizeNationalNumber(nextPhoneNumber);

  if (!normalizedPhone) {
    return {
      ok: false,
      error: 'Phone is required',
      phone: '',
      country_code: normalizedCountryCode,
      phone_number: normalizedPhoneNumber,
    };
  }

  if (normalizedPhone === '918155883039') {
    return {
      ok: false,
      error: 'This phone number is not allowed',
      phone: '',
      country_code: '',
      phone_number: '',
    };
  }

  if (normalizedPhone.length < 8 || normalizedPhone.length > 15) {
    return {
      ok: false,
      error: 'Phone number must contain 8 to 15 digits including country code',
      phone: normalizedPhone,
      country_code: normalizedCountryCode,
      phone_number: normalizedPhoneNumber,
    };
  }

  if (normalizedCountryCode && !normalizedPhone.startsWith(normalizedCountryCode)) {
    return {
      ok: false,
      error: 'Country code does not match phone number',
      phone: normalizedPhone,
      country_code: normalizedCountryCode,
      phone_number: normalizedPhoneNumber,
    };
  }

  const safeCountryCode = normalizedCountryCode || splitCombinedPhone(normalizedPhone, default_country_code).country_code;
  const safePhoneNumber = normalizedPhoneNumber || (safeCountryCode ? normalizedPhone.slice(safeCountryCode.length) : '');

  if (safePhoneNumber.length < 6 || safePhoneNumber.length > 13) {
    return {
      ok: false,
      error: 'Phone number part must contain 6 to 13 digits',
      phone: normalizedPhone,
      country_code: safeCountryCode,
      phone_number: safePhoneNumber,
    };
  }

  return {
    ok: true,
    error: '',
    phone: normalizedPhone,
    country_code: safeCountryCode,
    phone_number: safePhoneNumber,
  };
};

module.exports = {
  digitsOnly,
  normalizeCountryCode,
  normalizeNationalNumber,
  splitCombinedPhone,
  parsePhoneInput,
};
