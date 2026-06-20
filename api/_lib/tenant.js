// api/_lib/tenant.js
//
// Multi-tenant configuration loader.
//
// Each "tenant" is a builder-client who has their own Anaga instance —
// their own persona, project data, voice platform credentials, phone numbers,
// and lead database partition.
//
// Current implementation: env-based single tenant (Modcon as default) with
// Supabase clients-table lookup as the upgrade path for B2B SaaS.
//
// When TENANT_ID is not set → 'modcon' is assumed (the founding client).
// All multi-tenant env vars follow the pattern: TENANT_<ID>_<FIELD>
// e.g. TENANT_BUILDER2_NAME, TENANT_BUILDER2_GEMINI_API_KEY, …
//
// Later: replace env-based lookup with a Supabase row query per tenant_id.

import { rulesFor } from './prompts.js';

export function activeTenantId() {
  return (process.env.TENANT_ID || 'modcon').toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/**
 * Load config for a tenant. Returns a config object.
 * Falls back to the Modcon defaults if the tenant is not found.
 */
export async function getTenant(tenantId) {
  const id = (tenantId || activeTenantId()).toLowerCase();

  // Try Supabase clients table first (B2B SaaS path — requires SUPABASE_URL + SERVICE_KEY)
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const row = await fetchTenantFromSupabase(id);
      if (row) return normalizeTenant(row);
    } catch {
      // Fall through to env-based config
    }
  }

  return envTenant(id);
}

/**
 * List all registered tenants (for admin UI).
 * Returns an array of { id, name, createdAt } without secrets.
 */
export async function listTenants() {
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    try {
      const base = process.env.SUPABASE_URL.replace(/\/$/, '');
      const key = process.env.SUPABASE_SERVICE_KEY;
      const resp = await fetch(`${base}/rest/v1/clients?select=id,name,created_at&order=created_at.asc`, {
        headers: { apikey: key, Authorization: 'Bearer ' + key },
      });
      if (resp.ok) {
        const rows = await resp.json();
        return (Array.isArray(rows) ? rows : []).map((r) => ({
          id: r.id, name: r.name, createdAt: r.created_at,
        }));
      }
    } catch { /* fall through */ }
  }
  // Single-tenant fallback
  return [{ id: 'modcon', name: 'Modcon Builders', createdAt: null }];
}

/**
 * Register a new tenant client. Saves to Supabase clients table.
 * config must have: id, name, and optionally persona, projects, contact, voice_config.
 */
export async function registerTenant(config) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase not configured — cannot register tenant');
  }
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const row = {
    id: config.id,
    name: config.name,
    config: config,
    api_key: config.api_key || null,
  };
  const resp = await fetch(`${base}/rest/v1/clients`, {
    method: 'POST',
    headers: {
      apikey: key, Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  if (!resp.ok) {
    let d = ''; try { d = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    throw new Error('register_tenant_failed_' + resp.status + (d ? ': ' + d : ''));
  }
  return { ok: true, id: config.id };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchTenantFromSupabase(id) {
  const base = process.env.SUPABASE_URL.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_KEY;
  const resp = await fetch(
    `${base}/rest/v1/clients?id=eq.${encodeURIComponent(id)}&limit=1`,
    { headers: { apikey: key, Authorization: 'Bearer ' + key } }
  );
  if (!resp.ok) return null;
  const rows = await resp.json();
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

function normalizeTenant(row) {
  const cfg = (row.config && typeof row.config === 'object') ? row.config : {};
  return {
    id: row.id || 'modcon',
    name: row.name || cfg.name || 'Modcon Builders',
    geminiApiKey: cfg.gemini_api_key || process.env.GEMINI_API_KEY,
    geminiModel: cfg.gemini_model || process.env.GEMINI_MODEL || 'gemini-2.5-flash',
    voicePlatform: cfg.voice_platform || process.env.VOICE_PLATFORM || 'bolna',
    bolnaApiKey: cfg.bolna_api_key || process.env.BOLNA_API_KEY,
    bolnaAgentId: cfg.bolna_agent_id || process.env.BOLNA_AGENT_ID,
    bolnaFromNumber: cfg.bolna_from_number || process.env.BOLNA_FROM_NUMBER,
    whatsappToken: cfg.whatsapp_token || process.env.WHATSAPP_TOKEN,
    whatsappPhoneNumberId: cfg.whatsapp_phone_number_id || process.env.WHATSAPP_PHONE_NUMBER_ID,
    calendarId: cfg.google_calendar_id || process.env.GOOGLE_CALENDAR_ID,
    supabaseLeadsTable: cfg.supabase_leads_table || process.env.SUPABASE_LEADS_TABLE || 'leads',
    dashboardPasscode: cfg.dashboard_passcode || process.env.DASHBOARD_PASSCODE,
    persona: cfg.persona || null,
    projects: cfg.projects || null,
  };
}

function envTenant(id) {
  // Env vars: TENANT_<ID>_<FIELD> for secondary tenants, plain vars for default tenant
  const prefix = id === 'modcon' ? '' : `TENANT_${id.toUpperCase()}_`;
  const env = (key) => process.env[prefix ? prefix + key : key] || process.env[key] || '';

  return {
    id,
    name: env('TENANT_NAME') || 'Modcon Builders',
    geminiApiKey: env('GEMINI_API_KEY'),
    geminiModel: env('GEMINI_MODEL') || 'gemini-2.5-flash',
    voicePlatform: env('VOICE_PLATFORM') || 'bolna',
    bolnaApiKey: env('BOLNA_API_KEY'),
    bolnaAgentId: env('BOLNA_AGENT_ID'),
    bolnaFromNumber: env('BOLNA_FROM_NUMBER'),
    whatsappToken: env('WHATSAPP_TOKEN'),
    whatsappPhoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
    calendarId: env('GOOGLE_CALENDAR_ID'),
    supabaseLeadsTable: env('SUPABASE_LEADS_TABLE') || 'leads',
    dashboardPasscode: env('DASHBOARD_PASSCODE'),
    persona: null,
    projects: null,
  };
}
