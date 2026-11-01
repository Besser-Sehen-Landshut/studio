# Security review

**Question:** What can someone who should not be able to do something do with this code — and what
can an honest user leak by accident?

Start from the entry points in scope (HTTP routes and handlers, form and API actions, CLI arguments,
webhooks, file uploads, queue consumers, IPC commands) and follow each input to where it is used.

## Checks

1. **Authorization per action, not per page.** Every state-changing action checks that *this*
   caller may do *this* to *this* object — ownership, role and the object's current state. A page
   that only shows safe items does not protect the handler behind it: requests can be crafted.
   CSRF tokens and nonces prove intent, not permission.
2. **Authentication and sessions.** Tokens and magic links: entropy, expiry, single use or scoped
   use, stored hashed, compared in constant time, bound to an account whose rights are re-checked
   on use. Session fixation, logout that does not invalidate.
3. **Injection.** SQL (string-built queries, `LIKE` and `IN` lists, ORDER BY from input), shell
   (`exec`, `system`, backticks, unquoted variables in remote commands), HTML/JS (output without
   escaping, `innerHTML`, template raw filters), paths (`../`, symlinks), headers, LDAP, template
   engines, deserialization.
4. **Secrets.** Keys or passwords in code, logs, error messages, URLs (they end up in referrers and
   access logs), client bundles, or in files with world-readable permissions.
5. **Data exposure.** Responses that return more fields than the view needs; listings that ignore
   status or ownership; debug output and stack traces in production; IDs that can be enumerated.
6. **Unsafe defaults and configuration.** CORS with credentials and a reflected origin; cookies
   without `Secure`/`HttpOnly`/`SameSite`; permissive file modes; services bound to all interfaces;
   disabled TLS verification.
7. **Files and uploads.** Type checked by content, not name; stored outside the web root or served
   without execution; size limits; names sanitised.
8. **Rate limits** per account and IP on login, signup, reset, OTP and verification (short codes:
   lockout), and on endpoints whose abuse costs money or reaches real recipients (mail/SMS, LLM,
   payment, uploads). Missing there is critical.
9. **Row-level authorization.** Queries on user- or tenant-owned data are scoped by the session's
   tenant/user, never by input, or guarded by a database policy (Postgres RLS — mandatory where
   clients query the database directly). A new table for such data without either is critical.
10. **Dependencies used in scope.** A called library function with a known unsafe mode (e.g. YAML
   `load`, `pickle`, `eval`-like template features).

## Sweep

Probe for these and judge every hit:

- **Entry points:** route and handler registrations, `$_GET`/`$_POST`/`$_REQUEST`, `req.body`/
  `req.query`/`params`, server actions, `add_action( 'template_redirect' | 'admin_post_nopriv_' | 'wp_ajax_nopriv_' …)`,
  `#[tauri::command]`, CLI argument parsing, webhook receivers.
- **Writes reachable from them:** delete/trash/update/insert/publish/send calls — for each, find the
  authorization check *and* the object-state check on the same path.
- **Injection sinks:** string-built SQL, `exec`/`system`/`shell_exec`/backticks/`subprocess` with
  `shell=True`, `eval`, `innerHTML`/`dangerouslySetInnerHTML`, unescaped template output.
- **Secrets:** `password`, `secret`, `token`, `api_key`, private keys, `.env` values in code or logs;
  tokens in URLs.
- **Limits and scoping:** per login/signup/reset/OTP/send/upload handler, the limiter on its path
  (`rateLimit`, `throttle`, middleware, proxy); queries on owned tables without a tenant/user
  filter; `CREATE TABLE` without `ENABLE ROW LEVEL SECURITY` where the project uses RLS.

## Language notes

- **PHP / WordPress:** `current_user_can` on every handler, not only on the screen; `$wpdb->prepare`
  for every variable; `esc_html`/`esc_attr`/`esc_url` on output; `wp_verify_nonce` is not an
  authorization check; `template_redirect` and `admin_post_nopriv_` handlers run for anonymous users.
- **TypeScript / Node:** server actions and route handlers are public endpoints; validate with a
  schema at the boundary; `dangerouslySetInnerHTML`; SSRF through user-supplied URLs.
- **Swift / apps:** Keychain vs `UserDefaults` for secrets; ATS exceptions; URL scheme and
  universal-link handlers as entry points.
- **Rust / Tauri:** every `#[tauri::command]` is an entry point; capability and scope files;
  `unsafe` blocks.
- **Shell / infrastructure:** credentials on command lines (visible in `ps`); `curl | sh`;
  world-readable key files.

## Critical when

An unauthorised party can read, change or delete data or act as someone else, or a secret can
leave its intended boundary. Missing hardening with no reachable exploit is a note.
