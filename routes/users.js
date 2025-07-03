const express = require('express');
const { query, getUserStats } = require('../database');
const jwt = require('jsonwebtoken');
const router = express.Router();

// Middleware para verificar autenticación
const requireAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Token requerido' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'bizlyticsapp-secret-key-2025');
    
    // Verificar sesión activa
    const sessionResult = await query(
      'SELECT user_id, expires_at FROM sessions WHERE session_token = $1 AND user_id = $2',
      [token, decoded.userId]
    );

    if (sessionResult.rows.length === 0) {
      return res.status(401).json({ error: 'Sesión inválida' });
    }

    const session = sessionResult.rows[0];
    if (new Date() > new Date(session.expires_at)) {
      await query('DELETE FROM sessions WHERE session_token = $1', [token]);
      return res.status(401).json({ error: 'Sesión expirada' });
    }

    req.userId = decoded.userId;
    next();
  } catch (error) {
    console.error('Error en autenticación:', error);
    return res.status(401).json({ error: 'Token inválido' });
  }
};

// GET /api/users/profile - Obtener perfil del usuario
router.get('/profile', requireAuth, async (req, res) => {
  try {
    const userResult = await query(
      `SELECT id, email, name, company_name, subscription_status, 
              stripe_customer_id, created_at, updated_at 
       FROM users WHERE id = $1`,
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = userResult.rows[0];
    
    // Obtener estadísticas del usuario
    const stats = await getUserStats(req.userId);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company_name: user.company_name,
        subscription_status: user.subscription_status,
        has_stripe_customer: !!user.stripe_customer_id,
        created_at: user.created_at,
        updated_at: user.updated_at
      },
      stats
    });

  } catch (error) {
    console.error('Error obteniendo perfil:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT /api/users/profile - Actualizar perfil del usuario
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const { name, company_name } = req.body;

    // Validaciones
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'El nombre es requerido' });
    }

    if (name.length > 255) {
      return res.status(400).json({ error: 'El nombre es demasiado largo' });
    }

    if (company_name && company_name.length > 255) {
      return res.status(400).json({ error: 'El nombre de empresa es demasiado largo' });
    }

    // Actualizar usuario
    const updateResult = await query(
      `UPDATE users 
       SET name = $1, company_name = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE id = $3 
       RETURNING id, email, name, company_name, subscription_status, updated_at`,
      [name.trim(), company_name?.trim() || null, req.userId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = updateResult.rows[0];

    res.json({
      message: 'Perfil actualizado exitosamente',
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        company_name: user.company_name,
        subscription_status: user.subscription_status,
        updated_at: user.updated_at
      }
    });

  } catch (error) {
    console.error('Error actualizando perfil:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/users/stats - Obtener estadísticas del usuario
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const stats = await getUserStats(req.userId);
    
    // Obtener estadísticas adicionales
    const recentAlerts = await query(
      `SELECT id, alert_type, title, message, severity, is_read, created_at
       FROM alerts 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 5`,
      [req.userId]
    );

    const integrationTypes = await query(
      `SELECT integration_type, COUNT(*) as count
       FROM integrations 
       WHERE user_id = $1 AND is_active = true
       GROUP BY integration_type`,
      [req.userId]
    );

    const recentData = await query(
      `SELECT data_type, COUNT(*) as count, MAX(created_at) as last_sync
       FROM dashboard_data 
       WHERE user_id = $1 
       GROUP BY data_type 
       ORDER BY last_sync DESC`,
      [req.userId]
    );

    res.json({
      ...stats,
      recent_alerts: recentAlerts.rows,
      integration_breakdown: integrationTypes.rows,
      data_summary: recentData.rows
    });

  } catch (error) {
    console.error('Error obteniendo estadísticas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/users/alerts - Obtener alertas del usuario
router.get('/alerts', requireAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    const alertsResult = await query(
      `SELECT id, alert_type, title, message, severity, is_read, data, created_at
       FROM alerts 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT $2 OFFSET $3`,
      [req.userId, limit, offset]
    );

    const countResult = await query(
      'SELECT COUNT(*) as total FROM alerts WHERE user_id = $1',
      [req.userId]
    );

    const total = parseInt(countResult.rows[0].total);
    const totalPages = Math.ceil(total / limit);

    res.json({
      alerts: alertsResult.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1
      }
    });

  } catch (error) {
    console.error('Error obteniendo alertas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT /api/users/alerts/:id/read - Marcar alerta como leída
router.put('/alerts/:id/read', requireAuth, async (req, res) => {
  try {
    const alertId = parseInt(req.params.id);

    if (isNaN(alertId)) {
      return res.status(400).json({ error: 'ID de alerta inválido' });
    }

    const updateResult = await query(
      'UPDATE alerts SET is_read = true WHERE id = $1 AND user_id = $2 RETURNING id',
      [alertId, req.userId]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: 'Alerta no encontrada' });
    }

    res.json({ message: 'Alerta marcada como leída' });

  } catch (error) {
    console.error('Error marcando alerta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT /api/users/alerts/read-all - Marcar todas las alertas como leídas
router.put('/alerts/read-all', requireAuth, async (req, res) => {
  try {
    const updateResult = await query(
      'UPDATE alerts SET is_read = true WHERE user_id = $1 AND is_read = false',
      [req.userId]
    );

    res.json({ 
      message: 'Todas las alertas marcadas como leídas',
      updated: updateResult.rowCount
    });

  } catch (error) {
    console.error('Error marcando todas las alertas:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// DELETE /api/users/alerts/:id - Eliminar alerta
router.delete('/alerts/:id', requireAuth, async (req, res) => {
  try {
    const alertId = parseInt(req.params.id);

    if (isNaN(alertId)) {
      return res.status(400).json({ error: 'ID de alerta inválido' });
    }

    const deleteResult = await query(
      'DELETE FROM alerts WHERE id = $1 AND user_id = $2',
      [alertId, req.userId]
    );

    if (deleteResult.rowCount === 0) {
      return res.status(404).json({ error: 'Alerta no encontrada' });
    }

    res.json({ message: 'Alerta eliminada exitosamente' });

  } catch (error) {
    console.error('Error eliminando alerta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/users/integrations - Obtener integraciones del usuario
router.get('/integrations', requireAuth, async (req, res) => {
  try {
    const integrationsResult = await query(
      `SELECT id, integration_type, integration_name, is_active, created_at, updated_at
       FROM integrations 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [req.userId]
    );

    res.json({
      integrations: integrationsResult.rows
    });

  } catch (error) {
    console.error('Error obteniendo integraciones:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// DELETE /api/users/account - Eliminar cuenta del usuario
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Contraseña requerida para eliminar cuenta' });
    }

    // Verificar contraseña
    const userResult = await query(
      'SELECT password_hash FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const bcrypt = require('bcryptjs');
    const isValidPassword = await bcrypt.compare(password, userResult.rows[0].password_hash);

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    // Eliminar usuario (CASCADE eliminará datos relacionados)
    await query('DELETE FROM users WHERE id = $1', [req.userId]);

    res.json({ message: 'Cuenta eliminada exitosamente' });

  } catch (error) {
    console.error('Error eliminando cuenta:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
