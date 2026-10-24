const pool = require('../db');
const maxInt = 2147483647;
const safeFields = 'bank_id, bank_name, email, phone, address';

function safeBank(row) {
  return { bank_id: row.bank_id, bank_name: row.bank_name,
    email: row.email, phone: row.phone, address: row.address };
}

async function listBloodBanks(req, res) {
  try {
    // Recipient selection ke liye real bank profiles hain; secrets select nahi honge.
    const [banks] = await pool.execute('SELECT ' + safeFields + ' FROM blood_banks ORDER BY bank_name, bank_id');
    return res.status(200).json({ blood_banks: banks.map(safeBank) });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to retrieve blood banks.' });
  }
}

async function getBloodBank(req, res) {
  try {
    const value = req.params.bankId;
    const bankId = Number(value);
    if (!/^\d+$/.test(value) || !Number.isInteger(bankId) || bankId < 1 || bankId > maxInt) {
      return res.status(400).json({ message: 'bankId must be a positive integer within MySQL INT limits.' });
    }
    const [banks] = await pool.execute(
      'SELECT ' + safeFields + ' FROM blood_banks WHERE bank_id = ? LIMIT 1', [bankId]
    );
    if (!banks.length) return res.status(404).json({ message: 'Blood bank not found.' });
    return res.status(200).json({ blood_bank: safeBank(banks[0]) });
  } catch (error) {
    return res.status(500).json({ message: 'Unable to retrieve blood bank.' });
  }
}

module.exports = { listBloodBanks, getBloodBank };
