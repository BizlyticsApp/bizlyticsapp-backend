const express = require('express');
const { query } = require('../database');
const jwt = require('jsonwebtoken');
const router = express.Router();

// Configuración de Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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

// Configuración de planes
const PLANS = {
  pro: {
    name: 'Pro',
    price: 995, // €9.95 en centavos
    currency: 'eur',
    interval: 'month',
    features: [
      'Conexiones ilimitadas',
      'Alertas inteligentes',
      'Análisis con IA',
      'Soporte prioritario'
    ]
  },
  business: {
    name: 'Business',
    price: 1995, // €19.95 en centavos
    currency: 'eur',
    interval: 'month',
    features: [
      'Todo lo de Pro',
      'Múltiples negocios',
      'Reportes avanzados',
      'API access',
      'Soporte dedicado'
    ]
  }
};

// GET /api/subscriptions/plans - Obtener planes disponibles
router.get('/plans', async (req, res) => {
  try {
    const plansData = Object.entries(PLANS).map(([key, plan]) => ({
      id: key,
      name: plan.name,
      price: plan.price,
      currency: plan.currency,
      interval: plan.interval,
      features: plan.features,
      price_formatted: `€${(plan.price / 100).toFixed(2)}`
    }));

    res.json({
      plans: plansData
    });
  } catch (error) {
    console.error('Error obteniendo planes:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/subscriptions/current - Obtener suscripción actual
router.get('/current', requireAuth, async (req, res) => {
  try {
    const subscriptionResult = await query(
      `SELECT s.*, u.stripe_customer_id
       FROM subscriptions s
       JOIN users u ON s.user_id = u.id
       WHERE s.user_id = $1 AND s.status IN ('active', 'trialing', 'past_due')
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [req.userId]
    );

    if (subscriptionResult.rows.length === 0) {
      return res.json({
        subscription: null,
        status: 'free'
      });
    }

    const subscription = subscriptionResult.rows[0];
    
    // Si hay Stripe configurado, obtener datos actualizados
    let stripeSubscription = null;
    if (process.env.STRIPE_SECRET_KEY && subscription.stripe_subscription_id) {
      try {
        stripeSubscription = await stripe.subscriptions.retrieve(subscription.stripe_subscription_id);
      } catch (error) {
        console.error('Error obteniendo suscripción de Stripe:', error);
      }
    }

    const planInfo = PLANS[subscription.plan_type] || null;

    res.json({
      subscription: {
        id: subscription.id,
        plan_type: subscription.plan_type,
        plan_name: planInfo?.name || subscription.plan_type,
        status: stripeSubscription?.status || subscription.status,
        current_period_start: stripeSubscription?.current_period_start 
          ? new Date(stripeSubscription.current_period_start * 1000).toISOString()
          : subscription.current_period_start,
        current_period_end: stripeSubscription?.current_period_end
          ? new Date(stripeSubscription.current_period_end * 1000).toISOString()
          : subscription.current_period_end,
        cancel_at_period_end: stripeSubscription?.cancel_at_period_end || subscription.cancel_at_period_end,
        price: planInfo?.price || 0,
        price_formatted: planInfo ? `€${(planInfo.price / 100).toFixed(2)}` : '€0.00',
        features: planInfo?.features || []
      },
      status: stripeSubscription?.status || subscription.status
    });

  } catch (error) {
    console.error('Error obteniendo suscripción:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/subscriptions/create - Crear nueva suscripción
router.post('/create', requireAuth, async (req, res) => {
  try {
    const { plan_type, payment_method_id } = req.body;

    // Validar plan
    if (!PLANS[plan_type]) {
      return res.status(400).json({ error: 'Plan no válido' });
    }

    // Verificar si Stripe está configurado
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ 
        error: 'Sistema de pagos no configurado. Contacta al administrador.',
        code: 'STRIPE_NOT_CONFIGURED'
      });
    }

    // Obtener usuario
    const userResult = await query(
      'SELECT id, email, name, stripe_customer_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = userResult.rows[0];
    const plan = PLANS[plan_type];

    // Crear o obtener cliente de Stripe
    let stripeCustomerId = user.stripe_customer_id;
    
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: user.name,
        metadata: {
          user_id: user.id.toString(),
          app: 'BizlyticsApp'
        }
      });
      
      stripeCustomerId = customer.id;
      
      // Actualizar usuario con customer_id
      await query(
        'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
        [stripeCustomerId, user.id]
      );
    }

    // Crear suscripción en Stripe
    const subscription = await stripe.subscriptions.create({
      customer: stripeCustomerId,
      items: [{
        price_data: {
          currency: plan.currency,
          product_data: {
            name: `BizlyticsApp ${plan.name}`,
            description: `Plan ${plan.name} - ${plan.features.join(', ')}`
          },
          unit_amount: plan.price,
          recurring: {
            interval: plan.interval
          }
        }
      }],
      payment_behavior: 'default_incomplete',
      payment_settings: {
        payment_method_types: ['card'],
        save_default_payment_method: 'on_subscription'
      },
      expand: ['latest_invoice.payment_intent'],
      trial_period_days: 14, // 14 días de prueba
      metadata: {
        user_id: user.id.toString(),
        plan_type: plan_type
      }
    });

    // Guardar suscripción en base de datos
    await query(
      `INSERT INTO subscriptions (user_id, stripe_subscription_id, status, plan_type, 
                                 current_period_start, current_period_end, cancel_at_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        user.id,
        subscription.id,
        subscription.status,
        plan_type,
        new Date(subscription.current_period_start * 1000),
        new Date(subscription.current_period_end * 1000),
        subscription.cancel_at_period_end
      ]
    );

    // Actualizar status del usuario
    await query(
      'UPDATE users SET subscription_status = $1 WHERE id = $2',
      [subscription.status, user.id]
    );

    res.json({
      subscription: {
        id: subscription.id,
        status: subscription.status,
        client_secret: subscription.latest_invoice.payment_intent.client_secret,
        plan_type: plan_type,
        trial_end: subscription.trial_end ? new Date(subscription.trial_end * 1000).toISOString() : null
      }
    });

  } catch (error) {
    console.error('Error creando suscripción:', error);
    
    if (error.type === 'StripeCardError') {
      return res.status(400).json({ error: 'Error con la tarjeta: ' + error.message });
    }
    
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// PUT /api/subscriptions/update - Actualizar suscripción
router.put('/update', requireAuth, async (req, res) => {
  try {
    const { plan_type } = req.body;

    if (!PLANS[plan_type]) {
      return res.status(400).json({ error: 'Plan no válido' });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ 
        error: 'Sistema de pagos no configurado',
        code: 'STRIPE_NOT_CONFIGURED'
      });
    }

    // Obtener suscripción actual
    const subscriptionResult = await query(
      'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status = $2',
      [req.userId, 'active']
    );

    if (subscriptionResult.rows.length === 0) {
      return res.status(404).json({ error: 'No tienes una suscripción activa' });
    }

    const stripeSubscriptionId = subscriptionResult.rows[0].stripe_subscription_id;
    const plan = PLANS[plan_type];

    // Actualizar suscripción en Stripe
    const subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
      items: [{
        price_data: {
          currency: plan.currency,
          product_data: {
            name: `BizlyticsApp ${plan.name}`,
            description: `Plan ${plan.name} - ${plan.features.join(', ')}`
          },
          unit_amount: plan.price,
          recurring: {
            interval: plan.interval
          }
        }
      }],
      proration_behavior: 'create_prorations'
    });

    // Actualizar en base de datos
    await query(
      'UPDATE subscriptions SET plan_type = $1, updated_at = CURRENT_TIMESTAMP WHERE stripe_subscription_id = $2',
      [plan_type, stripeSubscriptionId]
    );

    res.json({
      message: 'Suscripción actualizada exitosamente',
      subscription: {
        id: subscription.id,
        status: subscription.status,
        plan_type: plan_type
      }
    });

  } catch (error) {
    console.error('Error actualizando suscripción:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// DELETE /api/subscriptions/cancel - Cancelar suscripción
router.delete('/cancel', requireAuth, async (req, res) => {
  try {
    const { immediate } = req.body;

    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ 
        error: 'Sistema de pagos no configurado',
        code: 'STRIPE_NOT_CONFIGURED'
      });
    }

    // Obtener suscripción actual
    const subscriptionResult = await query(
      'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND status IN ($2, $3)',
      [req.userId, 'active', 'trialing']
    );

    if (subscriptionResult.rows.length === 0) {
      return res.status(404).json({ error: 'No tienes una suscripción activa' });
    }

    const stripeSubscriptionId = subscriptionResult.rows[0].stripe_subscription_id;

    let subscription;
    if (immediate) {
      // Cancelar inmediatamente
      subscription = await stripe.subscriptions.cancel(stripeSubscriptionId);
    } else {
      // Cancelar al final del período
      subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
        cancel_at_period_end: true
      });
    }

    // Actualizar en base de datos
    await query(
      `UPDATE subscriptions 
       SET status = $1, cancel_at_period_end = $2, updated_at = CURRENT_TIMESTAMP 
       WHERE stripe_subscription_id = $3`,
      [subscription.status, subscription.cancel_at_period_end, stripeSubscriptionId]
    );

    // Si se canceló inmediatamente, actualizar usuario
    if (immediate) {
      await query(
        'UPDATE users SET subscription_status = $1 WHERE id = $2',
        ['free', req.userId]
      );
    }

    res.json({
      message: immediate ? 'Suscripción cancelada inmediatamente' : 'Suscripción se cancelará al final del período',
      subscription: {
        id: subscription.id,
        status: subscription.status,
        cancel_at_period_end: subscription.cancel_at_period_end,
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString()
      }
    });

  } catch (error) {
    console.error('Error cancelando suscripción:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/subscriptions/reactivate - Reactivar suscripción cancelada
router.post('/reactivate', requireAuth, async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ 
        error: 'Sistema de pagos no configurado',
        code: 'STRIPE_NOT_CONFIGURED'
      });
    }

    // Obtener suscripción cancelada
    const subscriptionResult = await query(
      'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 AND cancel_at_period_end = true',
      [req.userId]
    );

    if (subscriptionResult.rows.length === 0) {
      return res.status(404).json({ error: 'No tienes una suscripción pendiente de cancelación' });
    }

    const stripeSubscriptionId = subscriptionResult.rows[0].stripe_subscription_id;

    // Reactivar en Stripe
    const subscription = await stripe.subscriptions.update(stripeSubscriptionId, {
      cancel_at_period_end: false
    });

    // Actualizar en base de datos
    await query(
      'UPDATE subscriptions SET cancel_at_period_end = false, updated_at = CURRENT_TIMESTAMP WHERE stripe_subscription_id = $1',
      [stripeSubscriptionId]
    );

    res.json({
      message: 'Suscripción reactivada exitosamente',
      subscription: {
        id: subscription.id,
        status: subscription.status,
        cancel_at_period_end: false
      }
    });

  } catch (error) {
    console.error('Error reactivando suscripción:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/subscriptions/invoice-preview - Vista previa de factura
router.get('/invoice-preview/:plan_type', requireAuth, async (req, res) => {
  try {
    const { plan_type } = req.params;

    if (!PLANS[plan_type]) {
      return res.status(400).json({ error: 'Plan no válido' });
    }

    if (!process.env.STRIPE_SECRET_KEY) {
      // Si no hay Stripe configurado, devolver datos mock
      const plan = PLANS[plan_type];
      return res.json({
        plan_name: plan.name,
        amount: plan.price,
        currency: plan.currency,
        amount_formatted: `€${(plan.price / 100).toFixed(2)}`,
        trial_days: 14,
        next_payment_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      });
    }

    // Obtener usuario
    const userResult = await query(
      'SELECT stripe_customer_id FROM users WHERE id = $1',
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const plan = PLANS[plan_type];
    const stripeCustomerId = userResult.rows[0].stripe_customer_id;

    if (!stripeCustomerId) {
      return res.json({
        plan_name: plan.name,
        amount: plan.price,
        currency: plan.currency,
        amount_formatted: `€${(plan.price / 100).toFixed(2)}`,
        trial_days: 14,
        next_payment_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      });
    }

    // Crear vista previa de factura
    const invoicePreview = await stripe.invoices.createPreview({
      customer: stripeCustomerId,
      subscription_items: [{
        price_data: {
          currency: plan.currency,
          product_data: {
            name: `BizlyticsApp ${plan.name}`
          },
          unit_amount: plan.price,
          recurring: {
            interval: plan.interval
          }
        }
      }]
    });

    res.json({
      plan_name: plan.name,
      amount: invoicePreview.amount_due,
      currency: invoicePreview.currency,
      amount_formatted: `€${(invoicePreview.amount_due / 100).toFixed(2)}`,
      trial_days: 14,
      next_payment_date: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
    });

  } catch (error) {
    console.error('Error obteniendo vista previa:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
