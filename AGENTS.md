# Dummyplug development server

The browser calls OpenRouter through Dummyplug's server-side `/provider-bridge` middleware. When Codex starts the local development server, always run `npm run dev` with outbound network permission (`sandbox_permissions: require_escalated`). A sandboxed server can render the UI but cannot make any OpenRouter request.

The startup command performs a credential-free OpenRouter network preflight and deliberately exits before starting vinext when outbound access is unavailable. Do not bypass or remove that check to make startup appear successful.
