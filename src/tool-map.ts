/**
 * Which Crisper MCP tools each command covers, so every tool has a command
 * and every command names tools that exist. The first tool is the command's
 * own call (site commands also call list_sites to find the site); later ones
 * are equivalent tools on the server (older names or the same page), covered
 * by that command rather than given verbs of their own. Commands that only
 * work on this computer map to [].
 *
 * Checked by test/parity.test.ts against the live server's tool list, and by
 * the server's own repository against its code.
 */
export const COMMAND_TOOLS: Record<string, readonly string[]> = {
  "settings get": ["get_site_settings"],
  "settings update": ["update_site_settings"],
  "alerts get": ["get_alert_settings"],
  "alerts update": ["update_alert_settings"],
  "logs resend-options": ["get_resend_options"],
  "logs resend": ["resend_event"],
  login: ["get_connection"],
  logout: [],
  "auth status": [],
  "orgs list": ["get_connection"],
  "orgs use": ["get_connection"],
  "orgs create": ["create_organization"],
  "sites list": ["list_sites"],
  "sites use": ["list_sites"],
  "sites status": ["get_site_setup"],
  "sites health": ["get_site_health"],
  "sites add": ["create_site"],
  "billing status": ["get_billing_status"],
  // get_billing_options and start_billing_checkout return the same billing page.
  "billing link": [
    "get_billing_link",
    "start_billing_checkout",
    "get_billing_options",
  ],
  "billing cancel": ["cancel_billing"],
  "dns records": ["get_dns_records"],
  "dns check": ["check_dns"],
  "install check": ["check_install"],
  "install snippet": ["get_install_snippet"],
  "install guide": ["get_installation_guide"],
  "events list": ["list_recent_events"],
  "events verify": ["check_event"],
  "logs list": ["list_events"],
  "logs export": ["list_events"],
  "logs stats": ["get_event_stats"],
  "integrations list": ["list_integrations"],
  "integrations connect": ["connect_integration"],
  "integrations update": ["update_integration"],
  // start_integration_connection and attach_integration return the same setup page.
  "integrations link": [
    "get_integration_setup_link",
    "start_integration_connection",
    "attach_integration",
  ],
  commands: [],
};

/** Every MCP tool name some command covers. */
export const COVERED_TOOLS = [...new Set(Object.values(COMMAND_TOOLS).flat())];
