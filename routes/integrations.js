const express = require('express');
const { query } = require('../database');
const jwt = require('jsonwebtoken');
const axios = require('axios');
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

// Configuración de integraciones disponibles
const INTEGRATION_TYPES = {
  stripe: {
    name: 'Stripe',
    description: 'Datos de pagos y facturación',
    icon: 'credit-card',
    color: '#635BFF',
    requires_oauth: false,
    setup_url: null
  },
  google_analytics: {
    name: 'Google Analytics',
    description: 'Métricas de tráfico web',
    icon: 'bar-chart',
    color: '#FF6C37',
    requires_oauth: true,
    setup_url: 'https://accounts.google.com/o/oauth2/v2/auth'
  },
  gmail: {
    name: 'Gmail',
    description: 'Emails importantes del negocio',
    icon: 'mail',
    color: '#EA4335',
    requires_oauth: true,
    setup_url: 'https://accounts.google.com/o/oauth2/v2/auth'
  }
};

// GET /api/integrations - Obtener todas las integraciones del usuario
router.get('/', requireAuth, async (req, res) => {
  try {
    const integrationsResult = await query(
      `SELECT id, integration_type, integration_name, is_active, created_at, updated_at,
              CASE WHEN expires_at IS NOT NULL THEN expires_at > NOW() ELSE true END as token_valid
       FROM integrations 
       WHERE user_id = $1 
       ORDER BY created_at DESC`,
      [req.userId]
    );

    const integrations = integrationsResult.rows.map(integration => ({
      ...integration,
      config: INTEGRATION_TYPES[integration.integration_type] || null
    }));

    res.json({
      integrations,
      available_types: INTEGRATION_TYPES
    });

  } catch (error) {
    console.error('Error obteniendo integraciones:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/integrations/available - Obtener tipos de integración disponibles
router.get('/available', async (req, res) => {
  try {
    res.json({
      integration_types: INTEGRATION_TYPES
    });
  } catch (error) {
    console.error('Error obteniendo tipos disponibles:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/integrations/stripe - Configurar integración con Stripe
router.post('/stripe', requireAuth, async (req, res) => {
  try {
    // Para Stripe, obtenemos los datos desde la suscripción existente
    const userResult = await query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const stripeCustomerId = userResult.rows[0].stripe_customer_id;

    if (!stripeCustomerId) {
      return res.status(400).json({ 
        error: 'No tienes una cuenta de Stripe configurada. Necesitas una suscripción activa.',
        code: 'NO_STRIPE_CUSTOMER'
      });
    }

    // Verificar si ya existe integración de Stripe
    const existingResult = await query(
      'SELECT id FROM integrations WHERE user_id = $1 AND integration_type = $2',
      [req.userId, 'stripe']
    );

    if (existingResult.rows.length > 0) {
      // Actualizar integración existente
      await query(
        'UPDATE integrations SET is_active = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1',
        [existingResult.rows[0].id]
      );
    } else {
      // Crear nueva integración
      await query(
        `INSERT INTO integrations (user_id, integration_type, integration_name, is_active, additional_data)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          req.userId,
          'stripe',
          'Stripe Payments',
          true,
          JSON.stringify({ customer_id: stripeCustomerId })
        ]
      );
    }

    res.json({
      message: 'Integración con Stripe configurada exitosamente',
      integration: {
        type: 'stripe',
        name: 'Stripe Payments',
        status: 'active'
      }
    });

  } catch (error) {
    console.error('Error configurando Stripe:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/integrations/google-analytics - Iniciar OAuth para Google Analytics
router.post('/google-analytics', requireAuth, async (req, res) => {
  try {
    const { property_id } = req.body;

    if (!property_id) {
      return res.status(400).json({ error: 'Property ID de Google Analytics requerido' });
    }

    // En un entorno real, aquí iniciarías el flujo OAuth
    // Por ahora, simulamos la configuración
    const integrationResult = await query(
      `INSERT INTO integrations (user_id, integration_type, integration_name, is_active, additional_data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, integration_type) 
       DO UPDATE SET 
         integration_name = EXCLUDED.integration_name,
         is_active = EXCLUDED.is_active,
         additional_data = EXCLUDED.additional_data,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        req.userId,
        'google_analytics',
        `Analytics - ${property_id}`,
        true,
        JSON.stringify({ 
          property_id: property_id,
          setup_date: new Date().toISOString(),
          status: 'pending_oauth'
        })
      ]
    );

    res.json({
      message: 'Integración con Google Analytics iniciada',
      integration: {
        id: integrationResult.rows[0].id,
        type: 'google_analytics',
        name: `Analytics - ${property_id}`,
        status: 'pending_oauth',
        next_step: 'Completa la autorización OAuth en Google Analytics'
      }
    });

  } catch (error) {
    console.error('Error configurando Google Analytics:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/integrations/gmail - Iniciar OAuth para Gmail
router.post('/gmail', requireAuth, async (req, res) => {
  try {
    const { email_filters } = req.body;

    // En un entorno real, aquí iniciarías el flujo OAuth
    // Por ahora, simulamos la configuración
    const integrationResult = await query(
      `INSERT INTO integrations (user_id, integration_type, integration_name, is_active, additional_data)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, integration_type) 
       DO UPDATE SET 
         integration_name = EXCLUDED.integration_name,
         is_active = EXCLUDED.is_active,
         additional_data = EXCLUDED.additional_data,
         updated_at = CURRENT_TIMESTAMP
       RETURNING id`,
      [
        req.userId,
        'gmail',
        'Gmail Business',
        true,
        JSON.stringify({ 
          email_filters: email_filters || ['important', 'customer-support'],
          setup_date: new Date().toISOString(),
          status: 'pending_oauth'
        })
      ]
    );

    res.json({
      message: 'Integración con Gmail iniciada',
      integration: {
        id: integrationResult.rows[0].id,
        type: 'gmail',
        name: 'Gmail Business',
        status: 'pending_oauth',
        next_step: 'Completa la autorización OAuth en Gmail'
      }
    });

  } catch (error) {
    console.error('Error configurando Gmail:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT /api/integrations/:id - Actualizar integración
router.put('/:id', requireAuth, async (req, res) => {
  try {
    const integrationId = parseInt(req.params.id);
    const { integration_name, is_active, additional_data } = req.body;

    if (isNaN(integrationId)) {
      return res.status(400).json({ error: 'ID de integración inválido' });
    }

    // Verificar que la integración pertenece al usuario
    const integrationResult = await query(
      'SELECT id, integration_type FROM integrations WHERE id = $1 AND user_id = $2',
      [integrationId, req.userId]
    );

    if (integrationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Integración no encontrada' });
    }

    // Actualizar integración
    const updateFields = [];
    const updateValues = [];
    let valueIndex = 1;

    if (integration_name !== undefined) {
      updateFields.push(`integration_name = $${valueIndex++}`);
      updateValues.push(integration_name);
    }

    if (is_active !== undefined) {
      updateFields.push(`is_active = $${valueIndex++}`);
      updateValues.push(is_active);
    }

    if (additional_data !== undefined) {
      updateFields.push(`additional_data = $${valueIndex++}`);
      updateValues.push(JSON.stringify(additional_data));
    }

    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }

    updateFields.push(`updated_at = CURRENT_TIMESTAMP`);
    updateValues.push(integrationId, req.userId);

    const updateResult = await query(
      `UPDATE integrations 
       SET ${updateFields.join(', ')}
       WHERE id = $${valueIndex++} AND user_id = $${valueIndex++}
       RETURNING id, integration_type, integration_name, is_active, updated_at`,
      updateValues
    );

    res.json({
      message: 'Integración actualizada exitosamente',
      integration: updateResult.rows[0]
    });

  } catch (error) {
    console.error('Error actualizando integración:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// DELETE /api/integrations/:id - Eliminar integración
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const integrationId = parseInt(req.params.id);

    if (isNaN(integrationId)) {
      return res.status(400).json({ error: 'ID de integración inválido' });
    }

    // Verificar que la integración pertenece al usuario
    const deleteResult = await query(
      'DELETE FROM integrations WHERE id = $1 AND user_id = $2 RETURNING integration_type',
      [integrationId, req.userId]
    );

    if (deleteResult.rows.length === 0) {
      return res.status(404).json({ error: 'Integración no encontrada' });
    }

    // También eliminar datos relacionados del dashboard
    await query(
      'DELETE FROM dashboard_data WHERE integration_id = $1',
      [integrationId]
    );

    res.json({
      message: 'Integración eliminada exitosamente',
      deleted_type: deleteResult.rows[0].integration_type
    });

  } catch (error) {
    console.error('Error eliminando integración:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/integrations/:id/test - Probar conexión de integración
router.post('/:id/test', requireAuth, async (req, res) => {
  try {
    const integrationId = parseInt(req.params.id);

    if (isNaN(integrationId)) {
      return res.status(400).json({ error: 'ID de integración inválido' });
    }

    // Obtener integración
    const integrationResult = await query(
      'SELECT integration_type, integration_name, additional_data FROM integrations WHERE id = $1 AND user_id = $2',
      [integrationId, req.userId]
    );

    if (integrationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Integración no encontrada' });
    }

    const integration = integrationResult.rows[0];
    let testResult = { success: false, message: 'Test no implementado' };

    // Simular test según el tipo de integración
    switch (integration.integration_type) {
      case 'stripe':
        testResult = {
          success: true,
          message: 'Conexión con Stripe exitosa',
          data: {
            customer_id: 'cus_test123',
            status: 'active'
          }
        };
        break;

      case 'google_analytics':
        testResult = {
          success: true,
          message: 'Conexión con Google Analytics exitosa',
          data: {
            property_id: '12345678',
            sessions_last_30_days: 1250,
            status: 'connected'
          }
        };
        break;

      case 'gmail':
        testResult = {
          success: true,
          message: 'Conexión con Gmail exitosa',
          data: {
            emails_last_7_days: 15,
            important_emails: 3,
            status: 'connected'
          }
        };
        break;

      default:
        testResult = {
          success: false,
          message: 'Tipo de integración no soportado'
        };
    }

    res.json({
      integration: {
        id: integrationId,
        type: integration.integration_type,
        name: integration.integration_name
      },
      test_result: testResult
    });

  } catch (error) {
    console.error('Error probando integración:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/integrations/:id/sync - Sincronizar datos de integración
router.post('/:id/sync', requireAuth, async (req, res) => {
  try {
    const integrationId = parseInt(req.params.id);

    if (isNaN(integrationId)) {
      return res.status(400).json({ error: 'ID de integración inválido' });
    }

    // Obtener integración
    const integrationResult = await query(
      'SELECT integration_type, integration_name FROM integrations WHERE id = $1 AND user_id = $2 AND is_active = true',
      [integrationId, req.userId]
    );

    if (integrationResult.rows.length === 0) {
      return res.status(404).json({ error: 'Integración no encontrada o inactiva' });
    }

    const integration = integrationResult.rows[0];

    // Simular sincronización de datos
    const mockData = {
      stripe: {
        revenue_this_month: 1250.50,
        transactions_count: 25,
        new_customers: 8
      },
      google_analytics: {
        sessions: 1500,
        page_views: 4200,
        bounce_rate: 0.35
      },
      gmail: {
        total_emails: 45,
        important_emails: 12,
        customer_inquiries: 8
      }
    };

    const dataToSync = mockData[integration.integration_type] || {};

    // Guardar datos sincronizados
    await query(
      `INSERT INTO dashboard_data (user_id, integration_id, data_type, data_value, period_start, period_end)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        req.userId,
        integrationId,
        `${integration.integration_type}_sync`,
        JSON.stringify(dataToSync),
        new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 días atrás
        new Date()
      ]
    );

    res.json({
      message: `Datos de ${integration.integration_name} sincronizados exitosamente`,
      integration: {
        id: integrationId,
        type: integration.integration_type,
        name: integration.integration_name
      },
      synced_data: dataToSync,
      sync_timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error sincronizando integración:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/integrations/limits - Obtener límites según plan de suscripción
router.get('/limits', requireAuth, async (req, res) => {
  try {
    // Obtener plan del usuario
    const userResult = await query(
      'SELECT subscription_status FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const subscriptionStatus = userResult.rows[0].subscription_status;

    // Definir límites según plan
    let limits = {
      max_integrations: 2,
      available_types: ['stripe'],
      features: ['basic_analytics']
    };

    if (subscriptionStatus === 'active') {
      // Usuario con suscripción activa
      const subscriptionResult = await query(
        'SELECT plan_type FROM subscriptions WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 1',
        [req.userId, 'active']
      );

      if (subscriptionResult.rows.length > 0) {
        const planType = subscriptionResult.rows[0].plan_type;
        
        if (planType === 'pro') {
          limits = {
            max_integrations: 999,
            available_types: ['stripe', 'google_analytics', 'gmail'],
            features: ['unlimited_integrations', 'ai_insights', 'smart_alerts']
          };
        } else if (planType === 'business') {
          limits = {
            max_integrations: 999,
            available_types: ['stripe', 'google_analytics', 'gmail'],
            features: ['unlimited_integrations', 'ai_insights', 'smart_alerts', 'api_access', 'multiple_businesses']
          };
        }
      }
    }

    // Contar integraciones actuales
    const currentIntegrationsResult = await query(
      'SELECT COUNT(*) as count FROM integrations WHERE user_id = $1 AND is_active = true',
      [req.userId]
    );

    const currentCount = parseInt(currentIntegrationsResult.rows[0].count);

    res.json({
      subscription_status: subscriptionStatus,
      limits,
      current_integrations: currentCount,
      can_add_more: currentCount < limits.max_integrations
    });

  } catch (error) {
    console.error('Error obteniendo límites:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
