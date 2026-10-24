// Existing pool reuse kar rahe hain; naya database connection setup nahi chahiye.
const pool = require('../db');
const { randomBytes, scrypt } = require('crypto');
const { promisify } = require('util');
const hashPassword = promisify(scrypt);

async function registerRecipient(req, res) {
  try {
    // Sirf JSON object accept karenge, taaki galat body database tak na jaye.
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ message: 'Send a JSON object with recipient details.' });
    }

    const { name, gender, blood_group, age, phone, password } = req.body;
    const requiredFields = { name, gender, blood_group, phone, password };
    for (const [field, value] of Object.entries(requiredFields)) {
      if (typeof value !== 'string' || value.trim() === '') {
        return res.status(400).json({ message: field + ' is required and must be a non-empty string.' });
      }
    }

    // Column limits follow kar rahe hain, taaki data truncate na ho.
    if (name.trim().length > 100 || phone.trim().length > 15) {
      return res.status(400).json({ message: 'name must be at most 100 characters and phone at most 15 characters.' });
    }
    if (!/^\+?\d{10,15}$/.test(phone.trim())) {
      return res.status(400).json({ message: 'phone must contain 10 to 15 digits, optionally starting with +, and be at most 15 characters in total.' });
    }
    if (password.trim().length < 8) {
      return res.status(400).json({ message: 'password must contain at least 8 characters excluding leading and trailing whitespace.' });
    }

    // Sirf existing table ke ENUM values accept karenge.
    if (!['Male', 'Female', 'Other'].includes(gender)) {
      return res.status(400).json({ message: 'gender must be Male, Female, or Other.' });
    }
    if (!['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].includes(blood_group)) {
      return res.status(400).json({ message: 'Invalid blood_group.' });
    }

    // Recipients table mein DOB nahi, age hai; CHECK constraint 1 se 129 allow karta hai.
    if (!Number.isInteger(age) || age < 1 || age > 129) {
      return res.status(400).json({ message: 'age is required and must be an integer from 1 to 129.' });
    }

    // Optional fields blank ya missing hon to NULL save karenge.
    const optionalFields = { email: 100, address: 255, location: 100 };
    const optionalValues = {};
    for (const [field, maxLength] of Object.entries(optionalFields)) {
      const value = req.body[field];
      if (value != null && (typeof value !== 'string' || value.trim().length > maxLength)) {
        return res.status(400).json({ message: field + ' must be a string of at most ' + maxLength + ' characters.' });
      }
      optionalValues[field] = value == null || value.trim() === '' ? null : value.trim();
    }

    // Donor module jaisa email validation rakha hai, taaki rules consistent rahein.
    if (optionalValues.email !== null) {
      const email = optionalValues.email;
      const emailPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,63}$/;
      const localPart = email.split('@')[0];
      if (!emailPattern.test(email) || localPart.length > 64 || localPart.startsWith('.') ||
          localPart.endsWith('.') || localPart.includes('..')) {
        return res.status(400).json({ message: 'email must be a valid email address.' });
      }
    }

    // Admin reference optional hai; non-existing ID ko database foreign key reject karegi.
    const monitoredBy = req.body.monitored_by == null ? null : req.body.monitored_by;
    if (monitoredBy !== null && (!Number.isInteger(monitoredBy) || monitoredBy < 1 || monitoredBy > 2147483647)) {
      return res.status(400).json({ message: 'monitored_by must be a positive integer.' });
    }

    // Plain password save nahi karenge; har password ke liye random salt aur scrypt hash banega.
    const salt = randomBytes(16).toString('hex');
    const key = await hashPassword(password, salt, 64);
    const passwordHash = 'scrypt:' + salt + ':' + key.toString('hex');

    // Placeholders se input SQL se alag rahega, isliye SQL injection ka risk kam hota hai.
    const [result] = await pool.execute(
      'INSERT INTO recipients (name, gender, blood_group, age, phone, email, address, location, password_hash, monitored_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [name.trim(), gender, blood_group, age, phone.trim(), optionalValues.email,
        optionalValues.address, optionalValues.location, passwordHash, monitoredBy]
    );

    // Response mein sirf confirmation aur generated ID denge, password/hash nahi.
    return res.status(201).json({ message: 'Recipient registered successfully.', recipient_id: result.insertId });
  } catch (error) {
    // Current schema mein phone/email UNIQUE nahi hain; kisi unique conflict ko safely handle karenge.
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ message: 'Recipient conflicts with an existing record.' });
    }
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ message: 'monitored_by must refer to an existing admin.' });
    }
    // Internal SQL details ya secrets client ko nahi dikhayenge.
    return res.status(500).json({ message: 'Unable to register recipient.' });
  }
}

module.exports = { registerRecipient };
