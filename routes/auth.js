const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../database');
const router = express.Router();

// Función para generar token JWT
const generateToken = (userId) => {
  return jwt.sign(
    { userId },
    process.env.JWT_SECRET || 'bizlyticsapp-secret-key-2025',
    { expiresIn: '30d' }
  );
};

// Función para validar email
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// POST /api/auth/register - Registro de usuario
router.post('/register', async (req, res) => {
  try {
    const { email, password, name, company_name } = req.body;

    // Validaciones
    if (!email || !password || !name) {
      return res.status(400).json({
        error: 'Email, contraseña y nombre son requeridos'
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: 'Email no válido'
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'La contraseña debe tener al menos 6 caracteres'
      });
    }

    // Verificar si el usuario ya existe
    const existingUser = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({
        error: 'Ya existe un usuario con este email'
      });
    }

    // Hashear contraseña
    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    // Crear usuario
    const newUser = await query(
      `INSERT INTO users (email, password_hash, name, company_name, subscription_status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, email, name, company_name, subscription_status, created_at`,
      [email.toLowerCase(), passwordHash, name, company_name || null, 'free']
    );

    const user = newUser.rows[0];

    // Generar token
    const token = generateToken(user.id);

    // Crear sesión
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 días
    await query(
      'INSERT INTO sessions (user_id, session_token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    res.status(201).json({
      message: 'Usuario registrado exitosamente',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company_name: user.company_name,
        subscription_status: user.subscription_status,
        created_at: user.created_at
      },
      token
    });

  } catch (error) {
    console.error('Error en registro:', error);
    res.status(500).json({
      error: 'Error interno del servidor'
    });
  }
});

// POST /api/auth/login - Login de usuario
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validaciones
    if (!email || !password) {
      return res.status(400).json({
        error: 'Email y contraseña son requeridos'
      });
    }

    // Buscar usuario
    const userResult = await query(
      'SELECT id, email, password_hash, name, company_name, subscription_status FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({
        error: 'Email o contraseña incorrectos'
      });
    }

    const user = userResult.rows[0];

    // Verificar contraseña
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Email o contraseña incorrectos'
      });
    }

    // Generar nuevo token
    const token = generateToken(user.id);

    // Crear nueva sesión
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 días
    await query(
      'INSERT INTO sessions (user_id, session_token, expires_at) VALUES ($1, $2, $3)',
      [user.id, token, expiresAt]
    );

    res.json({
      message: 'Login exitoso',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company_name: user.company_name,
        subscription_status: user.subscription_status
      },
      token
    });

  } catch (error) {
    console.error('Error en login:', error);
    res.status(500).json({
      error: 'Error interno del servidor'
    });
  }
});

// POST /api/auth/logout - Logout de usuario
router.post('/logout', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (token) {
      // Eliminar sesión
      await query(
        'DELETE FROM sessions WHERE session_token = $1',
        [token]
      );
    }

    res.json({
      message: 'Logout exitoso'
    });

  } catch (error) {
    console.error('Error en logout:', error);
    res.status(500).json({
      error: 'Error interno del servidor'
    });
  }
});

// GET /api/auth/me - Obtener información del usuario actual
router.get('/me', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        error: 'Token no proporcionado'
      });
    }

    // Verificar token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'bizlyticsapp-secret-key-2025');
    } catch (error) {
      return res.status(401).json({
        error: 'Token inválido'
      });
    }

    // Verificar sesión
    const sessionResult = await query(
      'SELECT expires_at FROM sessions WHERE session_token = $1 AND user_id = $2',
      [token, decoded.userId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({
        error: 'Sesión no encontrada'
      });
    }

    const session = sessionResult.rows[0];
    if (new Date() > new Date(session.expires_at)) {
      // Eliminar sesión expirada
      await query('DELETE FROM sessions WHERE session_token = $1', [token]);
      return res.status(401).json({
        error: 'Sesión expirada'
      });
    }

    // Obtener información del usuario
    const userResult = await query(
      'SELECT id, email, name, company_name, subscription_status, created_at FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Usuario no encontrado'
      });
    }

    const user = userResult.rows[0];

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company_name: user.company_name,
        subscription_status: user.subscription_status,
        created_at: user.created_at
      }
    });

  } catch (error) {
    console.error('Error obteniendo usuario:', error);
    res.status(500).json({
      error: 'Error interno del servidor'
    });
  }
});

// POST /api/auth/forgot-password - Solicitar reset de contraseña
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: 'Email es requerido'
      });
    }

    // Verificar si existe el usuario
    const userResult = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    );

    // Siempre responder con éxito por seguridad
    res.json({
      message: 'Si el email existe, recibirás instrucciones para resetear tu contraseña'
    });

    // Solo proceder si el usuario existe
    if (userResult.rows.length > 0) {
      // Aquí se implementaría el envío de email
      // Por ahora solo loggeamos
      console.log(`Reset de contraseña solicitado para: ${email}`);
    }

  } catch (error) {
    console.error('Error en forgot-password:', error);
    res.status(500).json({
      error: 'Error interno del servidor'
    });
  }
});

// POST /api/auth/change-password - Cambiar contraseña
router.post('/change-password', async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const token = req.headers.authorization?.replace('Bearer ', '');

    if (!token) {
      return res.status(401).json({
        error: 'Token no proporcionado'
      });
    }

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Contraseña actual y nueva son requeridas'
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        error: 'La nueva contraseña debe tener al menos 6 caracteres'
      });
    }

    // Verificar token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'bizlyticsapp-secret-key-2025');
    } catch (error) {
      return res.status(401).json({
        error: 'Token inválido'
      });
    }

    // Obtener usuario y verificar contraseña actual
    const userResult = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({
        error: 'Usuario no encontrado'
      });
    }

    const user = userResult.rows[0];
    const isValidPassword = await bcrypt.compare(currentPassword, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Contraseña actual incorrecta'
      });
    }

    // Hashear nueva contraseña
    const saltRounds = 12;
    const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);

    // Actualizar contraseña
    await query(
      'UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
      [newPasswordHash, decoded.userId]
    );

    res.json({
      message: 'Contraseña actualizada exitosamente'
    });

  } catch (error) {
    console.error('Error cambiando contraseña:', error);
    res.status(500).json({
      error: 'Error interno del servidor'
    });
  }
});

module.exports = router;
