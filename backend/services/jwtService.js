const jwt = require('jsonwebtoken');

function getJwtConfig() {
  const secret = process.env.JWT_SECRET;
  const expiresIn = process.env.JWT_EXPIRES_IN?.trim();
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32 || !secret.trim() ||
      !/^[1-9]\d*[smhd]$/.test(expiresIn || '')) {
    const error = new Error('JWT configuration is unavailable.');
    error.code = 'JWT_CONFIG_ERROR';
    throw error;
  }
  return { secret, expiresIn };
}

const roles = ['donor', 'recipient', 'blood_bank', 'organization'];

function createToken(userId, userType) {
  if (!Number.isSafeInteger(userId) || userId < 1 || !roles.includes(userType)) {
    throw new Error('Invalid authentication identity.');
  }
  const { secret, expiresIn } = getJwtConfig();
  return jwt.sign({ user_id: userId, user_type: userType }, secret, { algorithm: 'HS256', expiresIn });
}

function verifyToken(token) {
  const { secret } = getJwtConfig();
  const payload = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (!payload || !Number.isSafeInteger(payload.user_id) || payload.user_id < 1 ||
      !roles.includes(payload.user_type) || !Number.isSafeInteger(payload.exp) || payload.exp < 1) {
    throw new Error('Invalid authentication identity.');
  }
  return { user_id: payload.user_id, user_type: payload.user_type };
}

module.exports = { createToken, verifyToken };
