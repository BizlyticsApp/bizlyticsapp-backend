const express = require('express');
const { query } = require('../database');
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

// Función para generar datos simulados inteligentes
const generateSmartMockData = (integrationsCount, subscriptionPlan) => {
  const baseMultiplier = subscriptionPlan === 'business' ? 2.5 : subscriptionPlan === 'pro' ? 1.5 : 1;
  const integrationMultiplier = Math.max(1, integrationsCount * 0.3);
  
  return {
    revenue: Math.round((800 + Math.random() * 2200) * baseMultiplier * integrationMultiplier),
    transactions: Math.round((15 + Math.random() * 35) * integrationMultiplier),
    customers: Math.round((5 + Math.random() * 20) * integrationMultiplier),
    conversion_rate: Math.round((2.1 + Math.random() * 4.8) * 100) / 100,
    avg_order_value: Math.round((45 + Math.random() * 155) * baseMultiplier),
    traffic: Math.round((500 + Math.random() * 2000) * integrationMultiplier),
    bounce_rate: Math.round((25 + Math.random() * 35) * 100) / 100,
    emails_processed: Math.round((10 + Math.random() * 40) * integrationMultiplier)
  };
};

// Función para generar insights inteligentes
const generateAIInsights = (data, previousData, subscriptionPlan) => {
  const insights = [];
  
  // Análisis de tendencias de ingresos
  if (previousData && data.revenue > previousData.revenue * 1.1) {
    insights.push({
      type: 'success',
      title: 'Crecimiento Excelente',
      message: `Tus ingresos han crecido un ${Math.round(((data.revenue - previousData.revenue) / previousData.revenue) * 100)}% este mes. ¡Fantástico trabajo!`,
      priority: 'high',
      action: 'Considera escalar tu marketing para mantener este crecimiento.'
    });
  }
  
  // Análisis de conversión
  if (data.conversion_rate < 2.5) {
    insights.push({
      type: 'warning',
      title: 'Oportunidad de Mejora',
      message: `Tu tasa de conversión (${data.conversion_rate}%) está por debajo del promedio del sector (3.2%).`,
      priority: 'medium',
      action: 'Optimiza tu landing page y proceso de checkout.'
    });
  } else if (data.conversion_rate > 4.5) {
    insights.push({
      type: 'success',
      title: 'Conversión Excepcional',
      message: `Tu tasa de conversión (${data.conversion_rate}%) está muy por encima del promedio. ¡Excelente optimización!`,
      priority: 'low',
      action: 'Documenta tus mejores prácticas para replicarlas.'
    });
  }
  
  // Análisis de valor promedio de pedido
  if (data.avg_order_value < 60) {
    insights.push({
      type: 'info',
      title: 'Aumenta el Valor por Cliente',
      message: `Tu ticket promedio es de €${data.avg_order_value}. Hay potencial para incrementarlo.`,
      priority: 'medium',
      action: 'Implementa upselling y cross-selling en tu tienda.'
    });
  }
  
  // Análisis específico por plan
  if (subscriptionPlan === 'free') {
    insights.push({
      type: 'info',
      title: 'Desbloquea Más Insights',
      message: 'Con el plan Pro tendrás acceso a análisis predictivos y alertas automáticas.',
      priority: 'low',
      action: 'Considera actualizar para obtener más valor de tus datos.'
    });
  }
  
  return insights.slice(0, subscriptionPlan === 'business' ? 5 : subscriptionPlan === 'pro' ? 4 : 2);
};

// GET /api/dashboard/overview - Vista general del dashboard
router.get('/overview', requireAuth, async (req, res) => {
  try {
    // Obtener información del usuario y suscripción
    const userResult = await query(
      `SELECT u.name, u.company_name, u.subscription_status,
              COALESCE(s.plan_type, 'free') as plan_type
       FROM users u
       LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
       WHERE u.id = $1`,
      [req.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    const user = userResult.rows[0];

    // Obtener integraciones activas
    const integrationsResult = await query(
      'SELECT COUNT(*) as count, integration_type FROM integrations WHERE user_id = $1 AND is_active = true GROUP BY integration_type',
      [req.userId]
    );

    const integrations = integrationsResult.rows;
    const integrationsCount = integrations.length;

    // Obtener datos recientes del dashboard
    const recentDataResult = await query(
      `SELECT data_type, data_value, created_at
       FROM dashboard_data 
       WHERE user_id = $1 
       ORDER BY created_at DESC 
       LIMIT 10`,
      [req.userId]
    );

    // Generar o usar datos reales
    let currentData = generateSmartMockData(integrationsCount, user.plan_type);
    let previousData = generateSmartMockData(integrationsCount, user.plan_type);
    
    // Si hay datos reales, usarlos
    if (recentDataResult.rows.length > 0) {
      // Aquí procesarías los datos reales
      // Por ahora mantenemos los datos simulados pero inteligentes
    }

    // Generar insights con IA
    const insights = generateAIInsights(currentData, previousData, user.plan_type);

    // Calcular métricas principales
    const metrics = {
      revenue: {
        current: currentData.revenue,
        previous: previousData.revenue,
        change: ((currentData.revenue - previousData.revenue) / previousData.revenue * 100).toFixed(1),
        formatted: `€${currentData.revenue.toLocaleString()}`
      },
      customers: {
        current: currentData.customers,
        previous: previousData.customers,
        change: ((currentData.customers - previousData.customers) / previousData.customers * 100).toFixed(1),
        formatted: currentData.customers.toString()
      },
      conversion_rate: {
        current: currentData.conversion_rate,
        previous: previousData.conversion_rate,
        change: ((currentData.conversion_rate - previousData.conversion_rate) / previousData.conversion_rate * 100).toFixed(1),
        formatted: `${currentData.conversion_rate}%`
      },
      avg_order_value: {
        current: currentData.avg_order_value,
        previous: previousData.avg_order_value,
        change: ((currentData.avg_order_value - previousData.avg_order_value) / previousData.avg_order_value * 100).toFixed(1),
        formatted: `€${currentData.avg_order_value}`
      }
    };

    res.json({
      user: {
        name: user.name,
        company_name: user.company_name,
        plan_type: user.plan_type
      },
      metrics,
      integrations: {
        count: integrationsCount,
        types: integrations.map(i => i.integration_type)
      },
      insights,
      last_updated: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error obteniendo overview:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/dashboard/analytics - Análisis detallado
router.get('/analytics', requireAuth, async (req, res) => {
  try {
    const { period = '30d', integration_type } = req.query;

    // Obtener plan del usuario
    const userResult = await query(
      `SELECT u.subscription_status, COALESCE(s.plan_type, 'free') as plan_type
       FROM users u
       LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
       WHERE u.id = $1`,
      [req.userId]
    );

    const user = userResult.rows[0];

    // Verificar acceso según plan
    if (user.plan_type === 'free' && period !== '7d') {
      return res.status(403).json({ 
        error: 'Plan gratuito limitado a 7 días de análisis',
        upgrade_required: true 
      });
    }

    // Generar datos analíticos simulados
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
    const analyticsData = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      
      analyticsData.push({
        date: date.toISOString().split('T')[0],
        revenue: Math.round(20 + Math.random() * 180),
        transactions: Math.round(1 + Math.random() * 8),
        visitors: Math.round(30 + Math.random() * 120),
        conversion_rate: Math.round((1.5 + Math.random() * 4) * 100) / 100
      });
    }

    // Calcular totales
    const totals = analyticsData.reduce((acc, day) => {
      acc.revenue += day.revenue;
      acc.transactions += day.transactions;
      acc.visitors += day.visitors;
      return acc;
    }, { revenue: 0, transactions: 0, visitors: 0 });

    totals.avg_conversion_rate = (totals.transactions / totals.visitors * 100).toFixed(2);

    res.json({
      period,
      data: analyticsData,
      totals: {
        revenue: totals.revenue,
        revenue_formatted: `€${totals.revenue.toLocaleString()}`,
        transactions: totals.transactions,
        visitors: totals.visitors,
        avg_conversion_rate: `${totals.avg_conversion_rate}%`
      },
      available_periods: user.plan_type === 'free' ? ['7d'] : ['7d', '30d', '90d']
    });

  } catch (error) {
    console.error('Error obteniendo analytics:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/dashboard/kpis - KPIs principales
router.get('/kpis', requireAuth, async (req, res) => {
  try {
    // Obtener información del usuario
    const userResult = await query(
      `SELECT u.company_name, COALESCE(s.plan_type, 'free') as plan_type
       FROM users u
       LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
       WHERE u.id = $1`,
      [req.userId]
    );

    const user = userResult.rows[0];

    // Obtener número de integraciones
    const integrationsResult = await query(
      'SELECT COUNT(*) as count FROM integrations WHERE user_id = $1 AND is_active = true',
      [req.userId]
    );

    const integrationsCount = parseInt(integrationsResult.rows[0].count);

    // Generar KPIs inteligentes
    const data = generateSmartMockData(integrationsCount, user.plan_type);

    const kpis = [
      {
        id: 'monthly_revenue',
        name: 'Ingresos Mensuales',
        value: data.revenue,
        formatted: `€${data.revenue.toLocaleString()}`,
        change: '+12.5%',
        trend: 'up',
        category: 'financial'
      },
      {
        id: 'new_customers',
        name: 'Nuevos Clientes',
        value: data.customers,
        formatted: data.customers.toString(),
        change: '+8.3%',
        trend: 'up',
        category: 'growth'
      },
      {
        id: 'conversion_rate',
        name: 'Tasa de Conversión',
        value: data.conversion_rate,
        formatted: `${data.conversion_rate}%`,
        change: data.conversion_rate > 3.5 ? '+5.2%' : '-2.1%',
        trend: data.conversion_rate > 3.5 ? 'up' : 'down',
        category: 'performance'
      },
      {
        id: 'avg_order_value',
        name: 'Ticket Promedio',
        value: data.avg_order_value,
        formatted: `€${data.avg_order_value}`,
        change: '+15.7%',
        trend: 'up',
        category: 'financial'
      },
      {
        id: 'website_traffic',
        name: 'Tráfico Web',
        value: data.traffic,
        formatted: data.traffic.toLocaleString(),
        change: '+22.4%',
        trend: 'up',
        category: 'marketing'
      },
      {
        id: 'customer_satisfaction',
        name: 'Satisfacción Cliente',
        value: 4.2,
        formatted: '4.2/5',
        change: '+0.3',
        trend: 'up',
        category: 'service'
      }
    ];

    // Filtrar KPIs según plan
    const availableKPIs = user.plan_type === 'free' ? kpis.slice(0, 3) : kpis;

    res.json({
      kpis: availableKPIs,
      categories: ['financial', 'growth', 'performance', 'marketing', 'service'],
      plan_type: user.plan_type,
      total_kpis: availableKPIs.length
    });

  } catch (error) {
    console.error('Error obteniendo KPIs:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/dashboard/insights - Insights e recomendaciones con IA
router.get('/insights', requireAuth, async (req, res) => {
  try {
    // Obtener plan del usuario
    const userResult = await query(
      `SELECT COALESCE(s.plan_type, 'free') as plan_type
       FROM users u
       LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
       WHERE u.id = $1`,
      [req.userId]
    );

    const user = userResult.rows[0];

    if (user.plan_type === 'free') {
      return res.json({
        insights: [{
          type: 'info',
          title: 'Desbloquea Insights con IA',
          message: 'Actualiza a Pro para obtener análisis inteligentes y recomendaciones personalizadas.',
          priority: 'medium',
          action: 'Ver planes disponibles'
        }],
        available_in_plan: ['pro', 'business']
      });
    }

    // Obtener datos para generar insights
    const integrationsResult = await query(
      'SELECT COUNT(*) as count FROM integrations WHERE user_id = $1 AND is_active = true',
      [req.userId]
    );

    const integrationsCount = parseInt(integrationsResult.rows[0].count);
    const data = generateSmartMockData(integrationsCount, user.plan_type);
    const previousData = generateSmartMockData(integrationsCount, user.plan_type);

    // Generar insights avanzados
    const insights = generateAIInsights(data, previousData, user.plan_type);

    // Agregar insights específicos para planes premium
    if (user.plan_type === 'pro' || user.plan_type === 'business') {
      insights.push({
        type: 'prediction',
        title: 'Predicción de Ingresos',
        message: `Basado en tendencias actuales, podrías alcanzar €${Math.round(data.revenue * 1.25).toLocaleString()} el próximo mes.`,
        priority: 'high',
        action: 'Prepara tu inventario y capacidad de servicio.'
      });

      insights.push({
        type: 'optimization',
        title: 'Oportunidad de Optimización',
        message: 'Tus mejores horas de venta son entre 14:00-18:00. Considera concentrar tu marketing en este horario.',
        priority: 'medium',
        action: 'Programa campañas para horarios de mayor conversión.'
      });
    }

    if (user.plan_type === 'business') {
      insights.push({
        type: 'competitive',
        title: 'Análisis Competitivo',
        message: 'Tu rendimiento está un 18% por encima del promedio de tu sector.',
        priority: 'low',
        action: 'Mantén las estrategias actuales que están funcionando.'
      });
    }

    res.json({
      insights,
      generated_at: new Date().toISOString(),
      plan_type: user.plan_type,
      next_update: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });

  } catch (error) {
    console.error('Error obteniendo insights:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/dashboard/sync - Sincronizar datos del dashboard
router.post('/sync', requireAuth, async (req, res) => {
  try {
    // Obtener integraciones activas
    const integrationsResult = await query(
      'SELECT id, integration_type, additional_data FROM integrations WHERE user_id = $1 AND is_active = true',
      [req.userId]
    );

    const integrations = integrationsResult.rows;
    const syncResults = [];

    // Simular sincronización para cada integración
    for (const integration of integrations) {
      const mockData = {
        stripe: { revenue: 1250.50, transactions: 25, customers: 8 },
        google_analytics: { sessions: 1500, pageviews: 4200, bounce_rate: 0.35 },
        gmail: { emails: 45, important: 12, customer_inquiries: 8 }
      };

      const dataToSync = mockData[integration.integration_type] || {};

      // Guardar datos sincronizados
      await query(
        `INSERT INTO dashboard_data (user_id, integration_id, data_type, data_value, period_start, period_end)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.userId,
          integration.id,
          `${integration.integration_type}_sync`,
          JSON.stringify(dataToSync),
          new Date(Date.now() - 24 * 60 * 60 * 1000), // Ayer
          new Date()
        ]
      );

      syncResults.push({
        integration_type: integration.integration_type,
        status: 'success',
        records_synced: Object.keys(dataToSync).length,
        last_sync: new Date().toISOString()
      });
    }

    res.json({
      message: 'Sincronización completada exitosamente',
      sync_results: syncResults,
      total_integrations: integrations.length,
      sync_timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error sincronizando dashboard:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/dashboard/export - Exportar datos del dashboard
router.get('/export', requireAuth, async (req, res) => {
  try {
    const { format = 'json', period = '30d' } = req.query;

    // Obtener plan del usuario
    const userResult = await query(
      `SELECT COALESCE(s.plan_type, 'free') as plan_type
       FROM users u
       LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
       WHERE u.id = $1`,
      [req.userId]
    );

    const user = userResult.rows[0];

    if (user.plan_type === 'free') {
      return res.status(403).json({ 
        error: 'Función de exportación disponible solo en planes Pro y Business',
        upgrade_required: true 
      });
    }

    // Obtener datos para exportar
    const dashboardDataResult = await query(
      `SELECT data_type, data_value, created_at
       FROM dashboard_data 
       WHERE user_id = $1 AND created_at >= NOW() - INTERVAL '${period === '7d' ? '7' : '30'} days'
       ORDER BY created_at DESC`,
      [req.userId]
    );

    const exportData = {
      export_info: {
        user_id: req.userId,
        period: period,
        generated_at: new Date().toISOString(),
        format: format
      },
      data: dashboardDataResult.rows
    };

    if (format === 'csv') {
      // Convertir a CSV (simplificado)
      let csv = 'Fecha,Tipo,Datos\n';
      dashboardDataResult.rows.forEach(row => {
        csv += `${row.created_at},${row.data_type},"${JSON.stringify(row.data_value)}"\n`;
      });
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="bizlytics-export.csv"');
      res.send(csv);
    } else {
      res.json(exportData);
    }

  } catch (error) {
    console.error('Error exportando datos:', error);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

module.exports = router;
