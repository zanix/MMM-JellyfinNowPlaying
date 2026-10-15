/* global Module, Log */

// MagicMirror requires a callback argument for hide()/show() before the options.
const noop = () => { /* empty */ };

Module.register("MMM-JellyfinNowPlaying", {
  requiresVersion: "2.26.0",

  /**
   * These are module defaults and should not be edited here.
   * Set the configuration in the global config.js.
   */
  defaults: {
    // Jellyfin server connection
    serverUrl: "http://localhost:8096",
    apiKey: "",
    username: "",
    password: "",
    useWebSocket: true,

    // Timing
    stoppedDisplaySeconds: 10,  // Seconds, minimum 0
    updateInterval: 10,  // Seconds, minimum 5

    // Display options
    showUserAvatar: true,
    showUserName: true,
    showDeviceIcon: true,
    showDeviceName: false,
    showStatusIcon: true,
    showLocationIcon: true,
    showProgressBar: true,
    showPoster: true,
    showTranscode: true,
    showMultipleUsers: true,
    hideWhenIdle: true,

    // Look and Feel
    fontSize: "small",  // MagicMirror size class: "xsmall" | "small" | "medium" | "large" | "xlarge"
    titleFontSize: "1em",
    textFontSize: "0.75em",
    posterWidth: "3.2em",
    accentColor: "#00a4dc",
    backgroundColor: "rgba(255,255,255,0.06)",
    playingColor: "#3fb950",
    pausedColor: "#f0b429",
    stoppedColor: "#e5534b",
    headerTemplate: "{header_text} ({play_count})",  // Replacement Options: "{header_text}" | "{play_count}" | "{user_count}"
    headerTemplateZero: "{header_text}",  // Replacement Options: "{header_text}" | "{play_count}" | "{user_count}"

    // Filtering options
    playbackLocation: "all",  // Options: "all" | "local" | "remote"
    mediaTypes: [],  // Options: [] (all) | ["movie", "series", "music", "other"]
    mediaTypeFilterMode: "allow",  // Options: "allow" | "block"
    users: [],
    userFilterMode: "allow",  // Options: "allow" | "block"
    userMapping: {},

    // Causes massive log spam, but can be useful for debugging.
    // Debug must also be enabled in the logLevel settings in the main MM config.
    debugSessionData: false
  },

  /**
   * Core method, called when all modules are loaded and the system is ready to boot up.
   */
  start () {
    Log.info(`Starting module: ${this.name} with identifier: ${this.identifier}`);
    this.sessions = [];
    this.error = null;
    this.loaded = false;

    // Validate and sanitize the configuration, fall back to defaults for invalid values.
    const {config, warnings, errors} = window.JNPConfig.validate(this.config, this.defaults);

    // Reload config with validated values so getTemplateData() can use them.
    this.config = config;

    // Log warnings to the console, but continue running with valid config values.
    warnings.forEach((warning) => Log.warn(`${this.name}: ${warning}`));

    // Log errors to the console and stop the module from running.
    if (errors.length) {
      errors.forEach((error) => Log.error(`${this.name}: ${error.message}`));
      this.error = errors[0].code;
      this.loaded = true;
      return;
    }
    this.sendSocketNotification("JNP_INIT", {identifier: this.identifier, config: this.config, defaults: this.defaults});
    this.startTicker();
  },

  /**
   * Core method, called by MagicMirror when the module is hidden (by another module,
   * or by our own hideWhenIdle). Stops fetching and ticking until resumed.
   */
  suspend () {
    // Our own idle hiding must keep receiving data, or we could never show again.
    if (this.moduleHidden) {
      Log.debug(`${this.name}: Ignoring suspend, hidden because idle`);
      return;
    }
    Log.info(`${this.name}: Suspending (${this.identifier})`);
    this.stopTicker();
    this.sendSocketNotification("JNP_SUSPEND", {identifier: this.identifier});
  },

  /**
   * Core method, called by MagicMirror when the module is shown again.
   */
  resume () {
    Log.info(`${this.name}: Resuming (${this.identifier})`);
    this.startTicker();
    this.sendSocketNotification("JNP_RESUME", {identifier: this.identifier});
  },

  /**
   * Core method, called to request any additional stylesheets that need to be loaded.
   */
  getStyles () {
    return ["MMM-JellyfinNowPlaying.css"];
  },

  /**
   * Core method, called to request additional scripts that need to be loaded.
   */
  getScripts () {
    return [this.file("lib/config.js")];
  },

  /**
   * Core method, called to request translation files.
   * Add a new language by adding translations/<lang>.json and listing it here.
   * Missing keys fall back to English.
   */
  getTranslations () {
    return {en: "translations/en.json"};
  },

  /**
   * Core method, called to request the template file.
   */
  getTemplate () {
    return "templates/nowplaying.njk";
  },

  /**
   * Override the getHeader function to generate the header or hide the header
   * depending on settings.
   */
  getHeader () {
    const sessions = this.sessions.filter((session) => session.state !== "stopped");
    const streams = sessions.length;
    const users = new Set(sessions.map((session) => session.userId)).size;

    let template = streams === 0 && users === 0
      ? this.config.headerTemplateZero
      : this.config.headerTemplate;
    template = this.replaceAll(template, "{header_text}", this.data.header);
    template = this.replaceAll(template, "{play_count}", streams);
    template = this.replaceAll(template, "{user_count}", users);
    return template;
  },

  /**
   * Core method, called when updateDom() is called to render the template.
   */
  getTemplateData () {
    return {
      config: this.config,
      error: this.error,
      errorText: this.error
        ? this.translate(`ERROR_${this.error}`)
        : "",
      loaded: this.loaded,
      sessions: this.sessions.map((session) => ({
        ...session,
        posterUrl: session.posterPath
          ? this.img(session.posterPath, this.posterRequestWidth())
          : null,
        avatarUrl: session.avatarPath
          ? this.img(session.avatarPath, 64)
          : null,
        percent: session.durationSeconds
          ? Math.min(100, session.positionSeconds / session.durationSeconds * 100)
          : 0,
        positionText: this.formatDuration(session.positionSeconds),
        durationText: this.formatDuration(session.durationSeconds)
      }))
    };
  },

  /**
   * Core method, called when node_helper sends notifications.
   */
  socketNotificationReceived (notification, payload) {
    if (payload.identifier !== this.identifier) {
      return;
    }

    // Update the session list or error state based on the notification type.
    if (notification === "JNP_SESSIONS") {
      Log.debug(`${this.name}: Received ${payload.sessions.length} session(s)`);
      this.sessions = payload.sessions;
      this.error = null;
      this.loaded = true;
    } else if (notification === "JNP_ERROR") {
      Log.warn(`${this.name}: Backend reported ${payload.code}`);
      this.error = payload.code;
      this.loaded = true;
    } else {
      return;
    }

    // Skip the re-render (and its fade + poster reload) when nothing visible changed;
    // tickProgress() keeps the progress bar moving using the fresh positions.
    const signature = this.renderSignature();
    if (signature === this.lastSignature) {
      return;
    }
    this.lastSignature = signature;
    Log.debug(`${this.name}: Session data changed: ${signature}`);

    // Hide the module when idle if configured to do so.
    const hide = this.config.hideWhenIdle && !this.sessions.length && !this.error;
    if (hide !== this.moduleHidden) {
      Log.debug(`${this.name}: Setting moduleHidden to ${hide}`);
      this.moduleHidden = hide;

      if (hide) {
        this.hide(300, noop, {lockString: this.identifier});
      } else {
        this.show(300, noop, {lockString: this.identifier});
      }
    }
    this.updateDom(0);
  },

  /**
   * Starts the 1-second progress ticker if it is not already running.
   */
  startTicker () {
    if (!this.progressTimer) {
      this.progressTimer = setInterval(() => this.tickProgress(), 1000);
    }
  },

  /**
   * Stops the progress ticker.
   */
  stopTicker () {
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  },

  /**
   * Replaces all occurrences of a string within the given string.
   * @param {string} str The string to search within
   * @param {string} find The string to find within str
   * @param {string} replace The string to use as a replacement for the find string
   * @return {string} A copy of str with all the find occurrences replaced with replace
   */
  replaceAll (str, find, replace) {
    let output = "";
    let idx = str.indexOf(find);
    while (idx >= 0) {
      output += str.substr(0, idx) + replace;
      // eslint-disable-next-line no-param-reassign
      str = str.substring(idx + find.length);
      idx = str.indexOf(find);
    }
    output += str;
    return output;
  },

  /**
   * Serializes everything that affects the rendered DOM.
   * Playback position and timestamps are excluded because they change on every update.
   */
  renderSignature () {
    return JSON.stringify({
      error: this.error,
      // eslint-disable-next-line no-unused-vars
      sessions: this.sessions.map(({positionSeconds, updatedAt, ...rest}) => rest)
    });
  },

  /**
   * Converts the posterWidth CSS length (e.g. "4.5em", "90px", "10vw") to a pixel
   * width to request from the server, doubled so posters stay sharp on hi-dpi screens.
   * The browser does the unit conversion; em units resolve against the module's
   * font size class, which sets an absolute size so the probe can live on the body.
   * @returns {number} the width to request, in pixels
   */
  posterRequestWidth () {
    const fallbackWidth = 90;
    const probe = document.createElement("div");
    probe.className = this.config.fontSize;
    probe.style.cssText = `position:absolute;visibility:hidden;height:0;width:${this.config.posterWidth}`;
    document.body.appendChild(probe);
    const pixels = probe.getBoundingClientRect().width;
    probe.remove();
    return Math.round((pixels || fallbackWidth) * 2);
  },

  /**
   * Gets the URL for an image proxy request to the node_helper, which will fetch
   * the image from the Jellyfin server.
   * @param {string} path the Jellyfin image path (e.g. /Items/12345/Images/Primary)
   * @param {number} width the desired width in pixels
   * @returns {string} the URL to use in an <img> tag
   */
  img (path, width) {
    return `${globalThis.config?.basePath || "/"}${this.name}/image?id=${encodeURIComponent(this.identifier)}&path=${encodeURIComponent(path)}&w=${width}`;
  },

  /**
   * Formats a number of seconds into a human-readable string (H:MM:SS or M:SS).
   * @param {number} seconds the number of seconds
   * @returns {string} the formatted time string
   */
  formatDuration (seconds) {
    // eslint-disable-next-line no-param-reassign
    seconds = Math.max(0, Math.floor(seconds));
    /* eslint-disable id-length */
    const h = Math.floor(seconds / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const s = seconds % 60;
    const p = (x) => String(x).padStart(2, "0");
    /* eslint-enable id-length */
    return h
      ? `${h}:${p(m)}:${p(s)}`
      : `${m}:${p(s)}`;
  },

  /**
   * Smooth progress between server updates without re-rendering.
   */
  tickProgress () {
    const root = document.getElementById(this.identifier);
    if (!root) {
      return;
    }
    this.sessions.forEach((sessions) => {
      if (sessions.state !== "playing") {
        return;
      }
      sessions.positionSeconds += 1;
      const el = root.querySelector(`[data-session="${sessions.id}"]`);
      if (!el || !sessions.durationSeconds) {
        return;
      }
      el.querySelector(".jnp-bar-fill").style.width =
        `${Math.min(100, sessions.positionSeconds / sessions.durationSeconds * 100)}%`;
      el.querySelector(".jnp-position").textContent = this.formatDuration(sessions.positionSeconds);
    });
  }
});
