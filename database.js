const { Pool } = require('pg');
require('dotenv').config();

// Configuración de conexión a PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10, // máximo número de conexiones
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Función para ejecutar queries
const query = async (text, params) => {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    console.log('Query ejecutada', { text, duration, rows: res.rowCount });
    return res;
  } catch (error) {
    console.error('Error en query:', error);
    throw error;
  }
};

// Función para crear todas las tablas
const createTables = async () => {
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      company_name VARCHAR(255),
      subscription_status VARCHAR(50) DEFAULT 'free',
      stripe_customer_id VARCHAR(255),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createSubscriptionsTable = `
    CREATE TABLE IF NOT EXISTS subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      stripe_subscription_id VARCHAR(255) UNIQUE,
      status VARCHAR(50) NOT NULL,
      plan_type VARCHAR(50) NOT NULL,
      current_period_start TIMESTAMP WITH TIME ZONE,
      current_period_end TIMESTAMP WITH TIME ZONE,
      cancel_at_period_end BOOLEAN DEFAULT false,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createIntegrationsTable = `
    CREATE TABLE IF NOT EXISTS integrations (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      integration_type VARCHAR(50) NOT NULL,
      integration_name VARCHAR(255) NOT NULL,
      access_token TEXT,
      refresh_token TEXT,
      expires_at TIMESTAMP WITH TIME ZONE,
      additional_data JSONB,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createDashboardDataTable = `
    CREATE TABLE IF NOT EXISTS dashboard_data (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      integration_id INTEGER REFERENCES integrations(id) ON DELETE CASCADE,
      data_type VARCHAR(50) NOT NULL,
      data_value JSONB NOT NULL,
      period_start TIMESTAMP WITH TIME ZONE,
      period_end TIMESTAMP WITH TIME ZONE,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createAlertsTable = `
    CREATE TABLE IF NOT EXISTS alerts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      alert_type VARCHAR(50) NOT NULL,
      title VARCHAR(255) NOT NULL,
      message TEXT NOT NULL,
      severity VARCHAR(20) DEFAULT 'info',
      is_read BOOLEAN DEFAULT false,
      data JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  const createSessionsTable = `
    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      session_token VARCHAR(255) UNIQUE NOT NULL,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;

  try {
    console.log('🔧 Creando tablas de BizlyticsApp...');
    
    await query(createUsersTable);
    console.log('✅ Tabla users creada');
    
    await query(createSubscriptionsTable);
    console.log('✅ Tabla subscriptions creada');
    
    await query(createIntegrationsTable);
    console.log('✅ Tabla integrations creada');
    
    await query(createDashboardDataTable);
    console.log('✅ Tabla dashboard_data creada');
    
    await query(createAlertsTable);
    console.log('✅ Tabla alerts creada');
    
    await query(createSessionsTable);
    console.log('✅ Tabla sessions creada');
    
    console.log('🚀 Todas las tablas de BizlyticsApp creadas exitosamente');
    
  } catch (error) {
    console.error('❌ Error creando tablas:', error);
    throw error;
  }
};

// Función para verificar conexión a la base de datos
const testConnection = async () => {
  try {
    const client = await pool.connect();
    console.log('✅ Conexión a PostgreSQL exitosa');
    
    const result = await client.query('SELECT NOW()');
    console.log('🕐 Tiempo del servidor:', result.rows[0].now);
    
    client.release();
    return true;
  } catch (error) {
    console.error('❌ Error conectando a PostgreSQL:', error);
    return false;
  }
};

// Función para obtener estadísticas de un usuario
const getUserStats = async (userId) => {
  try {
    const integrations = await query(
      'SELECT COUNT(*) as count FROM integrations WHERE user_id = $1 AND is_active = true',
      [userId]
    );
    
    const alerts = await query(
      'SELECT COUNT(*) as count FROM alerts WHERE user_id = $1 AND is_read = false',
      [userId]
    );
    
    const subscription = await query(
      'SELECT plan_type, status FROM subscriptions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1',
      [userId]
    );
    
    return {
      active_integrations: parseInt(integrations.rows[0].count),
      unread_alerts: parseInt(alerts.rows[0].count),
      subscription_plan: subscription.rows[0]?.plan_type || 'free',
      subscription_status: subscription.rows[0]?.status || 'inactive'
    };
  } catch (error) {
    console.error('Error obteniendo estadísticas del usuario:', error);
    throw error;
  }
};

// Función para limpiar sesiones expiradas
const cleanupExpiredSessions = async () => {
  try {
    const result = await query(
      'DELETE FROM sessions WHERE expires_at < NOW()',
      []
    );
    console.log(`🧹 Limpiadas ${result.rowCount} sesiones expiradas`);
  } catch (error) {
    console.error('Error limpiando sesiones:', error);
  }
};

// Función para cerrar el pool de conexiones
const closePool = async () => {
  try {
    await pool.end();
    console.log('🔐 Pool de conexiones cerrado');
  } catch (error) {
    console.error('Error cerrando pool:', error);
  }
};

// Exportar funciones
module.exports = {
  query,
  createTables,
  testConnection,
  getUserStats,
  cleanupExpiredSessions,
  closePool,
  pool
};
