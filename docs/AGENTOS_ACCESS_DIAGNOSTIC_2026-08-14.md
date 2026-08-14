# AgentOS Access Diagnostic

**Observed:** 2026-08-14

The Vercel project’s built-in **Agent** page loads successfully and shows only Vercel’s review/task interface. It does not display the reported message: “Google sign-in completed, but AgentOS could not confirm server access.” Therefore the failure is not explained by the project’s newly enabled Firestore persistence and should not be treated as a Firebase issue.

A preliminary external search identifies **Agno AgentOS** as the likely separate product surface. Its documented connection issues involve AgentOS-to-server connectivity rather than Vercel Firestore state. The next diagnostic requirement is the exact failing AgentOS URL or a screenshot of the message, followed by inspection of the AgentOS server URL, deployment accessibility, and configured authentication method.

## Official AgentOS connection guidance

The official Agno documentation states that AgentOS connection failures to a **local** server commonly arise when browsers block `os.agno.com` from accessing localhost or the local network. Chrome/Edge require an allowed local-network permission; a previously denied permission must be re-enabled in the site settings. Safari and Brave can block such connections, and a secure tunnel is the fallback when browser permissions cannot resolve the route.

This establishes an important distinction: the reported confirmation failure is most likely an AgentOS server-connection or browser-permission issue, not the Firestore configuration just activated on Vercel. The correct next evidence is the AgentOS server URL and whether it is a local address (`localhost`, `127.0.0.1`, or a LAN IP) or a public URL.

**Reference:** [Agno, “AgentOS Connection Issues”](https://docs.agno.com/faq/agentos-connection)

## Direct control-plane inspection

A direct navigation to `https://os.agno.com` did not retain an interactive AgentOS session in the available browser context; the page returned to a blank state before any connected runtime or endpoint could be inspected. Therefore the specific AgentOS runtime URL that produced the user-reported error remains unavailable from the current session. No AgentOS server configuration can be corrected safely until that endpoint is identified.

## Control-plane browser state

The explicit `https://os.agno.com/login` route remains on its loading state in the available browser session and does not render a usable sign-in or connection interface. This prevents discovery of the currently configured AgentOS endpoint from this session. The observed behavior is consistent with a Control Plane browser/application loading problem or a session-specific restriction, but it does not create evidence of a Firebase or Vercel project failure.

## Organization setup state

After the user-approved organization submission, the AgentOS page remained in the `Creating organization...` state instead of exposing the runtime connection form. This indicates a Control Plane account-setup/API response problem that occurs before any AgentOS runtime URL is entered. The next diagnostic step is inspection of the browser network response for the organization-creation request.

## Organization creation verified

A read-only authenticated API check confirms that the organization was created successfully and the signed-in user has `owner` permission. The stalled page is therefore a frontend state-refresh issue, not an account-creation failure. Reloading the AgentOS Control Plane should now expose the normal dashboard and runtime-connection form.

## Root cause and resolution

The local AgentOS runtime was healthy, but the Control Plane sends its `/health` request with both `Content-Type: application/json` and `credentials: include`. The initial CORS configuration permitted the explicit `https://os.agno.com` origin but did not return `Access-Control-Allow-Credentials: true`. A plain browser health request therefore succeeded, while the Control Plane’s own credentialed request failed and left the runtime inactive.

The runtime CORS policy now enables credentialed requests **only** for the explicit Control Plane and local development origins. The exact Control Plane request was retested successfully after the change. Reloading AgentOS then showed the **Anaga Operations** agent in the AgentOS dashboard, which confirms the server-access failure is resolved.

The runtime remains a local development process at `http://localhost:8000`. It is suitable for the Control Plane connection test but is not a persistent production deployment.
