/* Grant service_role access to app_config so edge functions can read the API key */
GRANT SELECT ON app_config TO service_role;
