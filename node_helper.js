"use strict";

const NodeHelper = require("node_helper");
const Log = require("logger");
const WebSocket = require("ws");
const JellyfinClient = require("./lib/client");
const {validate} = require("./lib/config");
const {filterSessions, SessionTracker, applyUserMap} = require("./lib/sessions");

// Only proxy Jellyfin primary images; anything else is rejected.
// eslint-disable-next-line prefer-named-capture-group
const IMAGE_RE = /^\/(Items|Users)\/[0-9a-fA-F-]{32,36}\/Images\/Primary$/u;

module.exports = NodeHelper.create({
  start () {
    Log.info("node_helper started");
    this.instances = {};
    this.routeAdded = false;
  },

  socketNotificationReceived (notification, payload) {
    if (notification === "JNP_INIT") {
      this.initInstance(payload);
    } else if (notification === "JNP_SUSPEND") {
      this.suspendInstance(payload.identifier);
    } else if (notification === "JNP_RESUME") {
      this.resumeInstance(payload.identifier);
    }
  },

  /**
   * Adds a route to the Express server to proxy image requests from the Jellyfin server.
   * This is necessary because the MagicMirror frontend may not be able to
   * directly access the Jellyfin server due to possible restrictions.
   * The route is only added once, even if multiple instances are initialized.
   */
  addImageRoute () {
    if (this.routeAdded) {
      return;
    }
    this.routeAdded = true;
    Log.debug("Registering image proxy route");
    this.expressApp.get("/MMM-JellyfinNowPlaying/image", async (req, res) => {
      const instance = this.instances[req.query.id];
      const path = String(req.query.path || "");
      if (!instance || !IMAGE_RE.test(path)) {
        Log.warn(`Rejected image request (unknown instance or invalid path): ${path}`);
        res.sendStatus(400);
        return;
      }
      try {
        const image = await instance.client.fetchImage(path, req.query.w);
        if (image.ok) {
          res.set("Content-Type", image.headers.get("content-type") || "image/jpeg");
          res.set("Cache-Control", "public, max-age=300");
          res.send(Buffer.from(await image.arrayBuffer()));
        } else {
          Log.warn(`Image fetch for ${path} returned HTTP ${image.status}`);
          res.sendStatus(image.status);
        }
      } catch (error) {
        Log.error(`Image failed for ${path}: ${error.message}`);
        res.sendStatus(502);
      }
    });
  },

  /**
   * Initializes a new instance of the Jellyfin client with the given identifier and configuration.
   * @param {Object} payload The notification payload.
   * @param {string} payload.identifier The identifier for this instance.
   * @param {Object} payload.config The configuration object for this instance.
   * @param {Object} payload.defaults The default configuration for this instance.
   * @returns Promise that resolves when the instance is initialized and connected, or rejects if there is an error.
   */
  async initInstance ({identifier, config: rawConfig, defaults}) {
    // Do not trust the configuration: validate and sanitize it here too.
    const {config, warnings, errors} = validate(rawConfig, defaults);
    warnings.forEach((warning) => Log.warn(`Config: ${warning}`));
    if (errors.length) {
      errors.forEach((error) => Log.error(`Config: ${error.message}`));
      this.sendSocketNotification("JNP_ERROR", {identifier, code: errors[0].code});
      return Promise.resolve();
    }
    Log.info(`Initializing instance ${identifier} for ${config.serverUrl} (auth: ${config.apiKey
      ? "apiKey"
      : "user/password"}, websocket: ${Boolean(config.useWebSocket)})`);

    // Create the image proxy route if it hasn't been added yet.
    this.addImageRoute();

    // Check for an existing instance, stop if it exists.
    if (this.instances[identifier]) {
      Log.debug(`Instance ${identifier} already exists, restarting it`);
      this.stopInstance(identifier);
    }

    // Create a new instance object and store it.
    const instance = {
      identifier,
      config,
      client: new JellyfinClient(config, {log: Log}),
      tracker: new SessionTracker(config.stoppedDisplaySeconds),
      lastSessions: [],
      timer: null,
      expiryTimer: null,
      wsTimer: null,
      pollGen: 0,
      ws: null,
      wsRetry: 0,
      closed: false,
      suspended: false
    };
    this.instances[identifier] = instance;

    // Connect to the Jellyfin server and start polling and/or WebSocket.
    try {
      await instance.client.connect();
      Log.info(`Connected to Jellyfin at ${config.serverUrl}`);
    } catch (error) {
      return this.sendError(instance, error);
    }
    // A suspend may have arrived while connecting; resumeInstance starts the work later.
    if (!instance.suspended) {
      this.startInstance(instance);
    }

    return Promise.resolve();
  },

  /**
   * Starts the WebSocket (if enabled) and the polling loop for an instance.
   * @param {*} instance The instance object to start.
   * @returns void
   */
  startInstance (instance) {
    if (instance.config.useWebSocket) {
      this.openSocket(instance);
    }
    this.startPolling(instance);
  },

  /**
   * Pauses all server activity for an instance (polling and WebSocket) while hidden.
   * The connection state and credentials are kept for resuming.
   * @param {string} id The identifier of the instance to suspend.
   * @returns void
   */
  suspendInstance (id) {
    const instance = this.instances[id];
    if (!instance || instance.suspended) {
      return;
    }
    Log.info(`Suspending instance ${id}`);
    instance.suspended = true;
    clearTimeout(instance.timer);
    clearTimeout(instance.wsTimer);
    clearTimeout(instance.expiryTimer);
    if (instance.ws) {
      instance.ws.terminate();
    }
  },

  /**
   * Restarts polling and the WebSocket for a suspended instance and refreshes immediately.
   * @param {string} id The identifier of the instance to resume.
   * @returns void
   */
  resumeInstance (id) {
    const instance = this.instances[id];
    if (!instance) {
      Log.warn(`Cannot resume unknown instance ${id}`);
      return;
    }
    if (!instance.suspended) {
      // Never suspended (idle hide, or a missed suspend): the data may still be stale.
      this.refreshOnce(instance);
      return;
    }
    Log.info(`Resuming instance ${id}`);
    instance.suspended = false;
    instance.wsRetry = 0;
    this.startInstance(instance);
  },

  /**
   * Fetches the sessions once and publishes them, outside the normal polling loop.
   * @param {*} instance The instance object to refresh.
   * @returns {Promise<void>} Resolves when the refresh has finished.
   */
  async refreshOnce (instance) {
    Log.debug("Refreshing sessions on resume");
    try {
      this.publish(instance, await instance.client.getNowPlaying());
    } catch (error) {
      this.sendError(instance, error);
    }
  },

  /**
   * Stops and cleans up an instance, terminating any active WebSocket and clearing timers.
   * @param {*} id The identifier of the instance to stop.
   * @returns void
   */
  stopInstance (id) {
    const instance = this.instances[id];
    if (!instance) {
      return;
    }
    Log.info(`Stopping instance ${id}`);
    instance.closed = true;
    clearTimeout(instance.timer);
    clearTimeout(instance.wsTimer);
    clearTimeout(instance.expiryTimer);
    if (instance.ws) {
      instance.ws.terminate();
    }
    delete this.instances[id];
  },

  /**
   * Starts the polling loop for the given instance.
   * If a WebSocket is active and working, polling will be less frequent.
   * @param {*} instance The instance object to start polling.
   * @returns void
   */
  startPolling (instance) {
    // A new generation invalidates any loop left over from before a suspend.
    instance.pollGen += 1;
    const gen = instance.pollGen;
    const isStale = () => instance.closed || instance.suspended || gen !== instance.pollGen;

    // Polling loop: fetch now playing, publish, and schedule the next poll.
    const tick = async () => {
      if (isStale()) {
        return;
      }
      // With a working socket, poll when the connection is lost.
      const wsOpen = instance.ws && instance.ws.readyState === WebSocket.OPEN;
      if (!wsOpen) {
        try {
          this.publish(instance, await instance.client.getNowPlaying());
        } catch (error) {
          if (JellyfinClient.classifyError(error) === "AUTH") {
            Log.warn("Auth rejected while polling; will re-authenticate on next poll");
            instance.client.resetAuth();
          }
          this.sendError(instance, error);
        }
      }
      if (isStale()) {
        return;
      }
      instance.timer = setTimeout(tick, Math.max(1, instance.config.updateInterval) * 1000);
    };
    tick();
  },

  /**
   * Opens a WebSocket connection to the Jellyfin server for the given instance.
   * @param {*} instance The instance object to open a WebSocket for.
   * @returns void
   */
  openSocket (instance) {
    if (instance.closed || instance.suspended) {
      return;
    }
    let ws;
    try {
      ws = new WebSocket(instance.client.webSocketUrl(), {
        headers: {Authorization: instance.client.authHeader()}
      });
    } catch (error) {
      Log.warn(`Could not create WebSocket: ${error.message}`);
      this.retrySocket(instance);
      return;
    }
    instance.ws = ws;

    // Handle WebSocket events.
    ws.on("open", () => {
      Log.info("WebSocket connected");
      instance.wsRetry = 0;
      ws.send(JSON.stringify({MessageType: "SessionsStart", Data: "0,1500"}));
    });

    // Handle incoming messages, which are expected to be JSON.
    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch (error) {
        Log.debug(`Ignoring non-JSON WebSocket message ${error.message}`);
        return;
      }
      Log.debug(`WebSocket message: ${msg.MessageType}`);
      if (msg.MessageType === "Sessions") {
        this.publish(instance, JellyfinClient.parseSessions(msg.Data));
      } else if (msg.MessageType === "ForceKeepAlive") {
        ws.send(JSON.stringify({MessageType: "KeepAlive"}));
      }
    });

    // Handle errors and closure of the WebSocket.
    ws.on("error", (error) => Log.warn(`WebSocket error: ${error.message}`));

    // When the WebSocket closes, attempt to retry the connection.
    ws.on("close", () => {
      Log.warn("WebSocket closed");
      instance.ws = null;
      this.retrySocket(instance);
    });
  },

  /**
   * Retries opening the WebSocket connection for the given instance, using progressive backoff.
   * @param {*} instance The instance object to retry the WebSocket for.
   * @returns void
   */
  retrySocket (instance) {
    if (instance.closed || instance.suspended) {
      return;
    }
    instance.wsRetry += 1;
    // Progressive backoff, capped at 60s.
    const delay = Math.min(60000, 2000 * 2 ** instance.wsRetry);
    Log.debug(`WebSocket retry #${instance.wsRetry} in ${delay}ms`);
    instance.wsTimer = setTimeout(() => this.openSocket(instance), delay); // polling covers the gap
  },

  /**
   * Publish sessions to the MagicMirror frontend. Performs filtering, tracking,
   * and user mapping before sending the notification.
   * @param {*} instance The instance object to publish for.
   * @param {*} sessions The list of session objects to publish.
   * @returns void
   */
  publish (instance, sessions) {
    if (instance.lastError) {
      Log.info(`Recovered from ${instance.lastError}`);
      instance.lastError = null;
    }
    const config = instance.config;
    // Filter -> track recently stopped -> map user names -> limit count.
    let list = filterSessions(sessions, config);
    list = instance.tracker.update(list);
    list = applyUserMap(list, config.userMapping);
    if (!config.showMultipleUsers) {
      list = list.slice(0, 1);
    }
    Log.debug(`Publishing ${list.length} session(s)`);
    // This causes a lot of log spam, so only log the session data when debugSessionData and MM debug are enabled.
    if (config.debugSessionData) {
      Log.debug("Session data:", list);
    }
    this.sendSocketNotification("JNP_SESSIONS", {identifier: instance.identifier, sessions: list});
    this.scheduleExpiry(instance, sessions);
  },

  /**
   * Re-publishes when the oldest stopped session is due to expire. Without this a stopped
   * card would stay until the next poll or WebSocket message, which may never come.
   * @param {*} instance The instance object to schedule for.
   * @param {*} sessions The raw session list that was just published.
   * @returns void
   */
  scheduleExpiry (instance, sessions) {
    clearTimeout(instance.expiryTimer);
    const wait = instance.tracker.nextExpiryMs();
    if (wait === null || instance.closed || instance.suspended) {
      return;
    }
    // Wait a bit more so the session is past its limit when the tracker runs.
    instance.expiryTimer = setTimeout(() => {
      Log.debug("Stopped session expired, refreshing");
      this.publish(instance, sessions);
    }, wait + 50);
  },

  /**
   * Sends an error notification to the MagicMirror frontend, logging it only if it is a new error code.
   * @param {*} instance The instance object to send the error for.
   * @param {*} error The error object that occurred.
   * @returns void
   */
  sendError (instance, error) {
    const code = JellyfinClient.classifyError(error);
    // Log only when the error changes so a down server doesn't flood the log every poll.
    if (instance.lastError === code) {
      Log.debug(`Still failing (${code}): ${error.message}`);
    } else {
      Log.error(`${code}: ${error.message}`);
      instance.lastError = code;
    }

    this.sendSocketNotification("JNP_ERROR", {identifier: instance.identifier, code});
  }
});
