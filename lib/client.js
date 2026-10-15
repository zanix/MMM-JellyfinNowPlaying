"use strict";

const {normalizeSession} = require("./sessions");

const PKG = {name: "MMM-JellyfinNowPlaying", version: "1.0.0"};

class JellyfinClient {
  /**
   * @param {object} opts { serverUrl, apiKey, username, password, deviceId }
   * @param {object} deps optional injection: { sdk, fetch, log } (log defaults to a no-op so the
   *   client can be used outside MagicMirror, e.g. in tests)
   */
  constructor (opts, deps = {}) {
    this.opts = opts;
    this.baseUrl = opts.serverUrl.replace(/\/+$/u, "");
    this.token = opts.apiKey || null;
    this.sdk = deps.sdk || null;
    this.log = deps.log || console;
    this.fetch = deps.fetch || globalThis.fetch;
    this.api = null;
  }

  /** Lazily loads the ESM-only Jellyfin SDK from this CommonJS module. */
  async loadSdk () {
    if (!this.sdk) {
      this.log.debug(`[${PKG.name}] Loading @jellyfin/sdk`);
      const mod = await import("@jellyfin/sdk");
      const api = await import("@jellyfin/sdk/lib/utils/api/session-api.js");
      const auth = await import("@jellyfin/sdk/lib/utils/api/authentication-api.js");
      this.sdk = {Jellyfin: mod.Jellyfin, getSessionApi: api.getSessionApi, getAuthenticationApi: auth.getAuthenticationApi};
    }
    return this.sdk;
  }

  /** Creates the API client and authenticates (API key, or username/password login). */
  async connect () {
    const sdk = await this.loadSdk();
    const jf = new sdk.Jellyfin({
      clientInfo: PKG,
      deviceInfo: {name: "MagicMirror", id: this.opts.deviceId || PKG.name}
    });
    this.log.debug(`[${PKG.name}] Connecting to ${this.baseUrl}`);
    this.api = jf.createApi(this.baseUrl, this.token);
    if (!this.token && this.opts.username) {
      this.log.info(`[${PKG.name}] Authenticating as "${this.opts.username}"`);
      const res = await sdk.getAuthenticationApi(this.api).authenticateUserByName({
        authenticateUserByName: {Username: this.opts.username, Pw: this.opts.password}
      });
      this.token = res.data.AccessToken;
      this.api.update({accessToken: this.token});
      this.log.info(`[${PKG.name}] Authenticated as "${this.opts.username}"`);
    } else if (!this.token) {
      this.log.error(`[${PKG.name}] No apiKey or username configured`);
      throw Object.assign(new Error("No apiKey or username configured"), {code: "NO_CREDENTIALS"});
    }
  }

  /** Fetches current sessions and returns only those that are playing something. */
  async getNowPlaying () {
    if (!this.api) {
      await this.connect();
    }
    const sdk = await this.loadSdk();
    const res = await sdk.getSessionApi(this.api).getSessions();
    const list = JellyfinClient.parseSessions(res.data);
    this.log.debug(`[${PKG.name}] ${(res.data || []).length} session(s), ${list.length} playing`);
    return list;
  }

  /**
   * Parses the raw session list from Jellyfin and returns only those that are
   * playing something, normalized to a consistent format.
   * @param {Array} rawList The raw session list from Jellyfin.
   * @returns {Array} The normalized session list.
   */
  static parseSessions (rawList) {
    return (rawList || []).map((rawItem) => normalizeSession(rawItem)).filter(Boolean);
  }

  /**
   * Fetches an image from the Jellyfin server, using the MediaBrowser auth header.
   * Returns a Response object.
   * @param {string} path The image path (e.g. /Items/12345/Images/Primary).
   * @param {number} maxWidth The maximum width of the image to fetch.
   * @returns {Promise<Response>} The fetch response.
   */
  fetchImage (path, maxWidth) {
    const url = `${this.baseUrl}${path}?maxWidth=${Number(maxWidth) || 400}&quality=90`;
    return this.fetch(url, {headers: {Authorization: this.authHeader()}});
  }

  /** Jellyfin MediaBrowser auth header; contains the token, do not log it. */
  authHeader () {
    return `MediaBrowser Client="${PKG.name}", Device="MagicMirror", DeviceId="${this.opts.deviceId || PKG.name}", Version="${PKG.version}", Token="${this.token}"`;
  }

  /**
   * Drops the API client (and the login token, unless it is a fixed API key)
   * so the next request re-authenticates.
   */
  resetAuth () {
    this.api = null;
    if (!this.opts.apiKey) {
      this.token = null;
    }
  }

  /**
   * WebSocket URL. Auth goes in the Authorization header (see authHeader);
   * newer servers reject api_key in the query string.
   */
  webSocketUrl () {
    return `${this.baseUrl.replace(/^http/iu, "ws")}/socket?deviceId=${encodeURIComponent(this.opts.deviceId || PKG.name)}`;
  }

  /** Maps errors to a user-presentable code. */
  static classifyError (err) {
    const status = err && err.response && err.response.status;
    if (err && err.code === "NO_CREDENTIALS") {
      return "NO_CREDENTIALS";
    }
    if (status === 401 || status === 403) {
      return "AUTH";
    }
    if (status >= 500) {
      return "SERVER";
    }
    return "NETWORK";
  }
}

module.exports = JellyfinClient;
