const express = require('express');
const { query } = require('../database');
const router = express.Router();

// Configuración de Stripe
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Función para verificar webhook de Stripe
const verifyStripeWebhook = (req) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!endpointSecret) {
    console.log('⚠️ Webhook de Stripe no configurado - usando modo de desarrollo');
    return true; // En desarrollo, aceptar sin verificar
  }

  try {
    const event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    return event;
  } catch (err) {
    console.error('❌ Error verificando webhook de Stripe:', err.message);
    return false;
  }
};

// Función para crear alerta para el usuario
const createUserAlert = async (userId, type, title, message, severity = 'info', data = null) => {
  try {
    await query(
      `INSERT INTO alerts (user_id, alert_type, title, message, severity, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, type, title, message, severity, data ? JSON.stringify(data) : null]
    );
    console.log(`🔔 Alerta creada para usuario ${userId}: ${title}`);
  } catch (error) {
    console.error('Error creando alerta:', error);
  }
};

// Función para obtener usuario por customer_id de Stripe
const getUserByStripeCustomer = async (stripeCustomerId) => {
  try {
    const result = await query(
      'SELECT id, email, name FROM users WHERE stripe_customer_id = $1',
      [stripeCustomerId]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  } catch (error) {
    console.error('Error obteniendo usuario por Stripe customer:', error);
    return null;
  }
};

// POST /api/webhooks/stripe - Webhook principal de Stripe
router.post('/stripe', async (req, res) => {
  try {
    // Verificar webhook
    const event = verifyStripeWebhook(req);
    
    if (!event) {
      return res.status(400).json({ error: 'Webhook verification failed' });
    }

    console.log(`🎯 Webhook recibido: ${event.type || 'desarrollo'}`);

    // Si no hay Stripe configurado, simular eventos para desarrollo
    if (!process.env.STRIPE_SECRET_KEY) {
      console.log('🔧 Modo desarrollo - simulando webhook');
      return res.json({ received: true, mode: 'development' });
    }

    // Procesar eventos de Stripe
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;

      case 'customer.subscription.trial_will_end':
        await handleTrialWillEnd(event.data.object);
        break;

      case 'customer.created':
        await handleCustomerCreated(event.data.object);
        break;

      default:
        console.log(`ℹ️ Evento no manejado: ${event.type}`);
    }

    res.json({ received: true });

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Manejar creación de suscripción
const handleSubscriptionCreated = async (subscription) => {
  try {
    console.log('✅ Procesando suscripción creada:', subscription.id);

    const user = await getUserByStripeCustomer(subscription.customer);
    if (!user) {
      console.error('❌ Usuario no encontrado para customer:', subscription.customer);
      return;
    }

    // Actualizar o crear suscripción en base de datos
    await query(
      `INSERT INTO subscriptions (user_id, stripe_subscription_id, status, plan_type, 
                                 current_period_start, current_period_end, cancel_at_period_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (stripe_subscription_id) 
       DO UPDATE SET 
         status = EXCLUDED.status,
         current_period_start = EXCLUDED.current_period_start,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at_period_end = EXCLUDED.cancel_at_period_end,
         updated_at = CURRENT_TIMESTAMP`,
      [
        user.id,
        subscription.id,
        subscription.status,
        subscription.metadata?.plan_type || 'pro',
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

    // Crear alerta de bienvenida
    await createUserAlert(
      user.id,
      'subscription_created',
      '¡Bienvenido a BizlyticsApp!',
      `Tu suscripción ${subscription.metadata?.plan_type || 'Pro'} está activa. ¡Comienza a conectar tus herramientas!`,
      'success',
      { subscription_id: subscription.id, plan: subscription.metadata?.plan_type }
    );

    console.log(`✅ Suscripción procesada para usuario ${user.email}`);

  } catch (error) {
    console.error('❌ Error manejando suscripción creada:', error);
  }
};

// Manejar actualización de suscripción
const handleSubscriptionUpdated = async (subscription) => {
  try {
    console.log('🔄 Procesando suscripción actualizada:', subscription.id);

    const user = await getUserByStripeCustomer(subscription.customer);
    if (!user) return;

    // Actualizar suscripción en base de datos
    await query(
      `UPDATE subscriptions 
       SET status = $1, 
           current_period_start = $2, 
           current_period_end = $3, 
           cancel_at_period_end = $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE stripe_subscription_id = $5`,
      [
        subscription.status,
        new Date(subscription.current_period_start * 1000),
        new Date(subscription.current_period_end * 1000),
        subscription.cancel_at_period_end,
        subscription.id
      ]
    );

    // Actualizar status del usuario
    await query(
      'UPDATE users SET subscription_status = $1 WHERE id = $2',
      [subscription.status, user.id]
    );

    // Crear alerta según el cambio
    let alertTitle = 'Suscripción Actualizada';
    let alertMessage = 'Tu suscripción ha sido actualizada exitosamente.';
    let alertSeverity = 'info';

    if (subscription.cancel_at_period_end) {
      alertTitle = 'Suscripción Programada para Cancelación';
      alertMessage = `Tu suscripción se cancelará el ${new Date(subscription.current_period_end * 1000).toLocaleDateString('es-ES')}. Puedes reactivarla en cualquier momento.`;
      alertSeverity = 'warning';
    } else if (subscription.status === 'active') {
      alertTitle = 'Suscripción Reactivada';
      alertMessage = '¡Genial! Tu suscripción está activa nuevamente.';
      alertSeverity = 'success';
    }

    await createUserAlert(
      user.id,
      'subscription_updated',
      alertTitle,
      alertMessage,
      alertSeverity,
      { subscription_id: subscription.id, status: subscription.status }
    );

    console.log(`✅ Suscripción actualizada para usuario ${user.email}`);

  } catch (error) {
    console.error('❌ Error manejando suscripción actualizada:', error);
  }
};

// Manejar eliminación de suscripción
const handleSubscriptionDeleted = async (subscription) => {
  try {
    console.log('❌ Procesando suscripción eliminada:', subscription.id);

    const user = await getUserByStripeCustomer(subscription.customer);
    if (!user) return;

    // Actualizar suscripción como cancelada
    await query(
      `UPDATE subscriptions 
       SET status = 'canceled', updated_at = CURRENT_TIMESTAMP
       WHERE stripe_subscription_id = $1`,
      [subscription.id]
    );

    // Actualizar usuario a plan gratuito
    await query(
      'UPDATE users SET subscription_status = $1 WHERE id = $2',
      ['free', user.id]
    );

    // Desactivar integraciones premium si es plan gratuito
    await query(
      `UPDATE integrations 
       SET is_active = false 
       WHERE user_id = $1 AND integration_type IN ('google_analytics', 'gmail')`,
      [user.id]
    );

    // Crear alerta de cancelación
    await createUserAlert(
      user.id,
      'subscription_canceled',
      'Suscripción Cancelada',
      'Tu suscripción ha sido cancelada. Puedes seguir usando las funciones básicas o reactivar tu plan en cualquier momento.',
      'warning',
      { subscription_id: subscription.id }
    );

    console.log(`✅ Suscripción cancelada para usuario ${user.email}`);

  } catch (error) {
    console.error('❌ Error manejando suscripción eliminada:', error);
  }
};

// Manejar pago exitoso
const handlePaymentSucceeded = async (invoice) => {
  try {
    console.log('💰 Procesando pago exitoso:', invoice.id);

    const user = await getUserByStripeCustomer(invoice.customer);
    if (!user) return;

    // Crear alerta de pago exitoso
    await createUserAlert(
      user.id,
      'payment_succeeded',
      'Pago Procesado Exitosamente',
      `Tu pago de €${(invoice.amount_paid / 100).toFixed(2)} ha sido procesado. ¡Gracias por tu confianza!`,
      'success',
      { 
        invoice_id: invoice.id, 
        amount: invoice.amount_paid / 100,
        currency: invoice.currency 
      }
    );

    console.log(`✅ Pago procesado para usuario ${user.email}: €${invoice.amount_paid / 100}`);

  } catch (error) {
    console.error('❌ Error manejando pago exitoso:', error);
  }
};

// Manejar pago fallido
const handlePaymentFailed = async (invoice) => {
  try {
    console.log('⚠️ Procesando pago fallido:', invoice.id);

    const user = await getUserByStripeCustomer(invoice.customer);
    if (!user) return;

    // Crear alerta de pago fallido
    await createUserAlert(
      user.id,
      'payment_failed',
      'Problema con el Pago',
      `No pudimos procesar tu pago de €${(invoice.amount_due / 100).toFixed(2)}. Por favor, actualiza tu método de pago para continuar con tu suscripción.`,
      'error',
      { 
        invoice_id: invoice.id, 
        amount: invoice.amount_due / 100,
        currency: invoice.currency 
      }
    );

    console.log(`⚠️ Pago fallido para usuario ${user.email}: €${invoice.amount_due / 100}`);

  } catch (error) {
    console.error('❌ Error manejando pago fallido:', error);
  }
};

// Manejar final de período de prueba próximo
const handleTrialWillEnd = async (subscription) => {
  try {
    console.log('⏰ Procesando final de prueba próximo:', subscription.id);

    const user = await getUserByStripeCustomer(subscription.customer);
    if (!user) return;

    const trialEndDate = new Date(subscription.trial_end * 1000);

    // Crear alerta de final de prueba
    await createUserAlert(
      user.id,
      'trial_ending',
      'Tu Prueba Gratuita Termina Pronto',
      `Tu período de prueba gratuita termina el ${trialEndDate.toLocaleDateString('es-ES')}. Asegúrate de tener un método de pago configurado para continuar sin interrupciones.`,
      'warning',
      { 
        subscription_id: subscription.id,
        trial_end: trialEndDate.toISOString()
      }
    );

    console.log(`⏰ Notificación de fin de prueba enviada a ${user.email}`);

  } catch (error) {
    console.error('❌ Error manejando fin de prueba:', error);
  }
};

// Manejar cliente creado
const handleCustomerCreated = async (customer) => {
  try {
    console.log('👤 Procesando cliente creado:', customer.id);

    // Buscar usuario por email si no tiene stripe_customer_id
    if (customer.email) {
      const userResult = await query(
        'SELECT id FROM users WHERE email = $1 AND stripe_customer_id IS NULL',
        [customer.email]
      );

      if (userResult.rows.length > 0) {
        const userId = userResult.rows[0].id;
        
        // Actualizar usuario con customer_id
        await query(
          'UPDATE users SET stripe_customer_id = $1 WHERE id = $2',
          [customer.id, userId]
        );

        console.log(`✅ Usuario ${customer.email} vinculado con Stripe customer ${customer.id}`);
      }
    }

  } catch (error) {
    console.error('❌ Error manejando cliente creado:', error);
  }
};

// GET /api/webhooks/test - Endpoint para probar webhooks
router.get('/test', async (req, res) => {
  try {
    res.json({
      status: 'ok',
      message: 'Webhook endpoint funcionando correctamente',
      timestamp: new Date().toISOString(),
      stripe_configured: !!process.env.STRIPE_SECRET_KEY,
      webhook_secret_configured: !!process.env.STRIPE_WEBHOOK_SECRET
    });
  } catch (error) {
    console.error('Error en test de webhook:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/webhooks/manual-sync - Sincronización manual de Stripe (para desarrollo)
router.post('/manual-sync', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'user_id requerido' });
    }

    // Simular eventos para desarrollo
    await createUserAlert(
      user_id,
      'manual_sync',
      'Sincronización Manual',
      'Datos sincronizados manualmente desde el sistema de desarrollo.',
      'info',
      { sync_type: 'manual', timestamp: new Date().toISOString() }
    );

    res.json({
      message: 'Sincronización manual completada',
      user_id: user_id,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error en sincronización manual:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/webhooks/events - Ver eventos recientes de webhooks (para debugging)
router.get('/events', async (req, res) => {
  try {
    const { limit = 20 } = req.query;

    // Obtener alertas recientes como proxy de eventos de webhook
    const eventsResult = await query(
      `SELECT alert_type, title, message, severity, data, created_at
       FROM alerts 
       WHERE alert_type IN ('subscription_created', 'subscription_updated', 'subscription_canceled', 
                            'payment_succeeded', 'payment_failed', 'trial_ending')
       ORDER BY created_at DESC 
       LIMIT $1`,
      [parseInt(limit)]
    );

    res.json({
      events: eventsResult.rows,
      total: eventsResult.rows.length,
      last_updated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error obteniendo eventos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
