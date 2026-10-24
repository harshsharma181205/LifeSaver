async function sendSMS(phoneNumber, message, providerSend) {
  if (typeof phoneNumber !== 'string' || phoneNumber.trim().length > 15 ||
      !/^\+?\d{10,15}$/.test(phoneNumber.trim()) ||
      typeof message !== 'string' || message.trim() === '' || [...message.trim()].length > 500) {
    return { status: 'invalid_input', sent: false };
  }

  // Default disabled hai; credentials source code mein nahi aayenge.
  const enabled = process.env.SMS_ENABLED?.trim().toLowerCase() === 'true';
  if (!enabled) return { status: 'disabled', sent: false };

  const provider = process.env.SMS_PROVIDER?.trim().toLowerCase();
  if (provider === 'test') {
    // Test mode network call nahi karti aur real delivery claim nahi karti.
    return { status: 'test_mode', sent: false };
  }
  const apiKey = process.env.SMS_API_KEY?.trim();
  const senderId = process.env.SMS_SENDER_ID?.trim();
  if (!provider || !apiKey || !senderId || typeof providerSend !== 'function') {
    return { status: 'not_configured', sent: false };
  }

  try {
    // Optional adapter tests mein mock hoga; real provider integration yahin isolate hogi.
    const sent = await providerSend({
      provider, apiKey, senderId, phoneNumber: phoneNumber.trim(), message: message.trim(),
    });
    return sent === true ? { status: 'sent', sent: true } : { status: 'failed', sent: false };
  } catch (error) {
    // Provider errors/keys client ya logs mein expose nahi karenge.
    return { status: 'failed', sent: false };
  }
}

module.exports = { sendSMS };
