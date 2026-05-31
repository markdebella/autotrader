/**
 * auth.js — Google Identity Services token management
 *
 * Flow:
 *  1. init()       — page load: sets up both GIS APIs, attempts silent sign-in
 *  2. Silent path  — google.accounts.id.prompt() fires silently if Google session
 *                    is active; callback then requests Drive token with prompt:''
 *  3. Manual path  — user clicks Sign In → requestAccessToken({ prompt:'' })
 *                    (skips account picker if Google session is active)
 *  4. signOut()    — revokes token, disables auto-select, clears state
 *  5. Auto-refresh — silent re-request 5 min before expiry
 */

const Auth = (() => {
  let tokenClient       = null;
  let tokenData         = null;   // { access_token, expires_at }
  let refreshTimer      = null;
  let gapiReady         = false;
  let _afterCredential  = false;
  let _loginHint        = null;

  /** Called when the OAuth2 token client delivers a token */
  function handleToken(response) {
    if (response.error) {
      if (_afterCredential) {
        _afterCredential = false;
        tokenClient.requestAccessToken({ login_hint: _loginHint || undefined });
        return;
      }
      Alpine.store('auth').status = 'signed_out';
      return;
    }
    _afterCredential = false;

    const expiresAt = Date.now() + (response.expires_in - 60) * 1000;
    tokenData = { access_token: response.access_token, expires_at: expiresAt };

    gapi.client.setToken({ access_token: response.access_token });
    localStorage.setItem('at_signed_in', '1');

    Alpine.store('auth').status = 'signed_in';

    // Schedule silent token refresh 5 min before expiry
    const refreshIn = expiresAt - Date.now() - 5 * 60 * 1000;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      if (tokenClient) tokenClient.requestAccessToken({ prompt: '' });
    }, Math.max(refreshIn, 0));

    App.onSignedIn();
  }

  /** Decode a JWT payload without verification (we trust Google's delivery) */
  function decodeJwtPayload(jwt) {
    try {
      const b64 = jwt.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      return JSON.parse(atob(b64));
    } catch { return null; }
  }

  /** Called by google.accounts.id (One Tap / silent sign-in) */
  function handleCredential(credentialResponse) {
    const payload = decodeJwtPayload(credentialResponse.credential);
    _loginHint = payload?.email ?? null;

    _afterCredential = true;
    if (tokenClient) tokenClient.requestAccessToken({ prompt: '', login_hint: _loginHint || undefined });
  }

  return {
    init() {
      // 1. OAuth2 token client (Drive access)
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.clientId,
        // drive.file → store app data in Drive; userinfo.email → lets the backend service
        // verify the access token belongs to the owner (via Google's tokeninfo endpoint).
        scope:     'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
        callback:  handleToken,
      });

      // 2. ID library (One Tap / silent sign-in)
      google.accounts.id.initialize({
        client_id:           CONFIG.clientId,
        auto_select:         true,
        callback:            handleCredential,
        cancel_on_tap_outside: false,
      });

      // 3. Load GAPI, then attempt silent sign-in
      gapi.load('client', async () => {
        await gapi.client.init({});
        gapiReady = true;
        Alpine.store('auth').gapiReady = true;

        // One Tap (silent auto sign-in) only works on real https origins. On
        // localhost / 127.0.0.1 it always fails with a /gsi/status 403 ("origin is not
        // allowed for the given client ID"), spamming the console, so skip it there.
        const isLocalOrigin = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
        if (localStorage.getItem('at_signed_in') && !isLocalOrigin) {
          google.accounts.id.prompt((notification) => {
            if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
              // One Tap unavailable (e.g. the browser's tracking prevention blocked
              // Google's storage). Do NOT fall back to an automatic requestAccessToken:
              // a popup not triggered by a user gesture is blocked by the browser and
              // signs nobody in. Fall through to the Sign In button instead — the user's
              // click supplies the gesture the OAuth popup needs (the path that works).
              Alpine.store('auth').status = 'signed_out';
            }
          });
        }
      });
    },

    /** Manual sign-in — called when user clicks the Sign In button */
    signIn() {
      tokenClient.requestAccessToken({ prompt: '' });
    },

    signOut() {
      if (tokenData?.access_token) {
        google.accounts.oauth2.revoke(tokenData.access_token, () => {});
      }
      google.accounts.id.disableAutoSelect();
      tokenData = null;
      clearTimeout(refreshTimer);
      gapi.client.setToken(null);
      Alpine.store('auth').status   = 'signed_out';
      Alpine.store('data').manifest = null;
      Alpine.store('data').settings = null;
      Alpine.store('portfolio').account   = null;
      Alpine.store('portfolio').positions = [];
      Alpine.store('portfolio').orders    = [];
      localStorage.removeItem('at_folder_id');
      localStorage.removeItem('at_signed_in');
    },

    getToken()   { return tokenData?.access_token ?? null; },
    isSignedIn() { return !!tokenData?.access_token && Date.now() < (tokenData?.expires_at ?? 0); },
  };
})();
