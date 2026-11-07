'use strict';

// School Manager SaaS — local auth: bcrypt password hashing + server JWT.
// No external auth provider. The JWT is signed with JWT_SECRET (env only)
// and is the ONLY token the server issues or accepts.
// Payload: sub (user id), school_id (null for super_admin), role, email.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { jwtSecret } = require('../config');

const SALT_ROUNDS = 10;
const TOKEN_TTL = '24h';

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch (_) {
    return false;
  }
}

function signToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      school_id: user.school_id || null,
      role: user.role,
      email: user.email,
    },
    jwtSecret,
    { expiresIn: TOKEN_TTL }
  );
}

// Returns the decoded payload, or throws on an invalid/expired token.
function verifyToken(token) {
  return jwt.verify(token, jwtSecret);
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
