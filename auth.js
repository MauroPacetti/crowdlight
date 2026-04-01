const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { stmts } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'crowdlight-secret-change-in-production';
const JWT_EXPIRES = '7d';

function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Express middleware
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token richiesto' });
  }
  const decoded = verifyToken(auth.slice(7));
  if (!decoded) {
    return res.status(401).json({ error: 'Token non valido' });
  }
  req.user = decoded;
  next();
}

function setupAuthRoutes(app) {
  app.post('/api/auth/register', (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password e nome richiesti' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password minimo 6 caratteri' });
    }

    const existing = stmts.getUserByEmail.get(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ error: 'Email già registrata' });
    }

    const hash = bcrypt.hashSync(password, 10);
    const result = stmts.createUser.run(email.toLowerCase().trim(), hash, name.trim());
    const user = { id: result.lastInsertRowid, email: email.toLowerCase().trim(), name: name.trim() };
    const token = generateToken(user);

    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  });

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email e password richiesti' });
    }

    const user = stmts.getUserByEmail.get(email.toLowerCase().trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const token = generateToken(user);
    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  });

  app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = stmts.getUserById.get(req.user.id);
    if (!user) return res.status(404).json({ error: 'Utente non trovato' });
    res.json({ user });
  });
}

module.exports = { setupAuthRoutes, requireAuth, verifyToken, JWT_SECRET };
