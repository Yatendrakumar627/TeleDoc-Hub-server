const { verifyToken } = require('../utils/authUtil');

/**
 * Middleware: Requires a valid JWT in Authorization: Bearer <token>
 */
function requireAuth(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({
      error: 'Authentication required. Please sign in to access your secure vault.',
      code: 'AUTH_REQUIRED',
    });
  }

  const decoded = verifyToken(token);

  if (!decoded || !decoded.userId) {
    return res.status(401).json({
      error: 'Invalid or expired session. Please sign in again.',
      code: 'AUTH_INVALID',
    });
  }

  req.user = {
    id: decoded.userId,
    email: decoded.email,
    name: decoded.name,
    role: decoded.role,
  };

  next();
}

/**
 * Optional Auth Middleware: Attaches req.user if token is present, continues otherwise
 */
function optionalAuth(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (token) {
    const decoded = verifyToken(token);
    if (decoded && decoded.userId) {
      req.user = {
        id: decoded.userId,
        email: decoded.email,
        name: decoded.name,
        role: decoded.role,
      };
    }
  }
  next();
}

module.exports = {
  requireAuth,
  optionalAuth,
};

