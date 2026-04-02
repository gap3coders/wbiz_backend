const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Contact = require('../models/Contact');
const { parsePhoneInput } = require('../utils/phone');

const run = async () => {
  await connectDB();
  const defaultCountryCode = String(process.env.DEFAULT_COUNTRY_CODE || '91');
  const cursor = Contact.find({}).cursor();
  let scanned = 0;
  let updated = 0;
  let skipped = 0;

  for await (const contact of cursor) {
    scanned += 1;
    const parsed = parsePhoneInput({
      phone: contact.phone || contact.whatsapp_id,
      country_code: contact.country_code,
      phone_number: contact.phone_number,
      default_country_code: defaultCountryCode,
    });

    if (!parsed.ok) {
      skipped += 1;
      continue;
    }

    const changed =
      String(contact.phone || '') !== parsed.phone ||
      String(contact.country_code || '') !== parsed.country_code ||
      String(contact.phone_number || '') !== parsed.phone_number ||
      String(contact.whatsapp_id || '') !== parsed.phone;

    if (!changed) continue;

    contact.phone = parsed.phone;
    contact.country_code = parsed.country_code;
    contact.phone_number = parsed.phone_number;
    contact.whatsapp_id = parsed.phone;
    await contact.save();
    updated += 1;
  }

  console.log(
    JSON.stringify(
      {
        scanned,
        updated,
        skipped,
        default_country_code: defaultCountryCode,
      },
      null,
      2
    )
  );
};

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
