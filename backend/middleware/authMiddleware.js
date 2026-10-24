const { verifyToken } = require('../services/jwtService');

function authenticate(req, res, next) {
  const authorization = req.headers.authorization;
  const match = typeof authorization === 'string'
    ? authorization.match(/^Bearer ([^\s]+)$/i)
    : null;
  if (!match) {
    return res.status(401).json({ message: 'A valid Bearer token is required.' });
  }

  try {
    // Signature/expiry check ke baad hi req.user set karenge.
    req.user = verifyToken(match[1]);
    return next();
  } catch (error) {
    if (error.code === 'JWT_CONFIG_ERROR') {
      return res.status(500).json({ message: 'Authentication is temporarily unavailable.' });
    }
    return res.status(401).json({ message: 'Invalid or expired authentication token.' });
  }
}

module.exports = authenticate;
