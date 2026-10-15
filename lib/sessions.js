"use strict";

// Jellyfin uses 100-nanosecond ticks for time values,
// so we need to convert to seconds.
const TICKS_PER_SECOND = 10000000;

/**
 * Returns true if the given IP address is a private/local address.
 * @param {string} addr The IP address to check.
 * @returns {boolean} True if the address is private/local, false otherwise.
 */
function isPrivateAddress (addr) {
  if (!addr) {
    return true;
  } // unknown -> treat as local
  const ip = String(addr).replace(/^::ffff:/u, "")
    // eslint-disable-next-line prefer-named-capture-group
    .replace(/^\[|\](\d+)?$/gu, "");
  if (ip === "::1" || ip === "localhost") {
    return true;
  }
  if ((/^fe80:/iu).test(ip) || (/^f[cd][0-9a-f]{2}:/iu).test(ip)) {
    return true;
  }
  // eslint-disable-next-line prefer-named-capture-group
  const match = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)/u);
  if (!match) {
    return false;
  }
  const [ma, mb] = [Number(match[1]), Number(match[2])];
  return ma === 10 || ma === 127 || ma === 172 && mb >= 16 && mb <= 31 || ma === 192 && mb === 168 || ma === 169 && mb === 254;
}

/**
 * Returns the media kind for the given type.
 * @param {string} type The media type.
 * @returns {string} The media kind ("movie", "series", "music", or "other").
 */
function getMediaType (type) {
  switch (type) {
    case "Movie": return "movie";
    case "Episode": return "series";
    case "Audio": case "AudioBook": case "MusicVideo": return "music";
    default: return "other";
  }
}

/**
 * Returns the image path for the given media item.
 * @param {Object} item The media item.
 * @returns {string|null} The image path, or null if not available.
 */
function imagePath (item) {
  if (!item) {
    return null;
  }
  const kind = getMediaType(item.Type);
  if (kind === "series" && item.SeriesId) {
    return `/Items/${item.SeriesId}/Images/Primary`;
  }
  if (kind === "music" && item.AlbumId) {
    return `/Items/${item.AlbumId}/Images/Primary`;
  }
  if (item.ImageTags && item.ImageTags.Primary) {
    return `/Items/${item.Id}/Images/Primary`;
  }
  if (item.Id) {
    return `/Items/${item.Id}/Images/Primary`;
  }
  return null;
}

/**
 * Returns the device kind for the given session.
 * @param {Object} session The session object.
 * @returns {string} The device kind ("tv", "phone", "tablet", or "computer").
 */
function deviceKind (session) {
  const deviceString = `${session.DeviceName || ""} ${session.Client || ""}`.toLowerCase();
  if ((/tv|android tv|apple tv|chromecast|fire|kodi|playstation|roku|tizen|webos|xbox|wholphin/u).test(deviceString)) {
    return "tv";
  }
  if ((/brave|chrome|firefox|safari|vivaldi/u).test(deviceString)) {
    return "browser";
  }
  if ((/phone|android|ios|iphone|mobile/u).test(deviceString) && !(/tv/u).test(deviceString)) {
    return "phone";
  }
  if ((/tablet|ipad/u).test(deviceString)) {
    return "tablet";
  }
  return "computer";
}

/**
 * Returns the subtitle for the given media item and kind.
 * @param {Object} item The media item.
 * @param {string} kind The media kind.
 * @returns {string} The subtitle.
 */
function subtitle (item, kind) {
  // For series, show season and episode numbers
  if (kind === "series") {
    const season = item.ParentIndexNumber; const
      episode = item.IndexNumber;
    const code = [
      season === null
        ? null
        : `S${season}`,
      episode === null
        ? null
        : `E${episode}`
    ].filter(Boolean).join(" • ");
    return [code, item.Name].filter(Boolean).join(": ");
  }
  // Music shows the artist and album on their own lines instead
  if (kind === "music") {
    return "";
  }
  // Otherwise, show production year if available
  return item.ProductionYear
    ? String(item.ProductionYear)
    : "";
}

/**
 * Normalizes a raw session object from Jellyfin.
 * @param {Object} raw The raw session object.
 * @param {number} [now=Date.now()] The current timestamp.
 * @returns {Object|null} The normalized session object, or null if invalid.
 */
function normalizeSession (raw, now = Date.now()) {
  const item = raw && raw.NowPlayingItem;
  if (!item) {
    return null;
  }
  const mediaType = getMediaType(item.Type);
  const ps = raw.PlayState || {};
  return {
    id: raw.Id,
    userId: raw.UserId,
    userName: raw.UserName || "Unknown",
    avatarPath: raw.UserId
      ? `/Users/${raw.UserId}/Images/Primary`
      : null,
    kind: mediaType,
    title: mediaType === "series"
      ? item.SeriesName || item.Name
      : item.Name,
    subtitle: subtitle(item, mediaType),
    artist: mediaType === "music"
      ? (item.Artists || [item.AlbumArtist]).filter(Boolean).join(", ")
      : "",
    album: mediaType === "music"
      ? item.Album || ""
      : "",
    state: ps.IsPaused
      ? "paused"
      : "playing",
    positionSeconds: (ps.PositionTicks || 0) / TICKS_PER_SECOND,
    durationSeconds: (item.RunTimeTicks || 0) / TICKS_PER_SECOND,
    transcoding: ps.PlayMethod === "Transcode" || Boolean(raw.TranscodingInfo),
    isRemote: !isPrivateAddress(raw.RemoteEndPoint),
    deviceName: raw.DeviceName || "",
    deviceKind: deviceKind(raw),
    client: raw.Client || "",
    posterPath: imagePath(item),
    updatedAt: now
  };
}

/**
 * Filters a value against a list using the specified mode.
 * @param {string} value The value to check.
 * @param {Array} list The list of values.
 * @param {string} mode The filter mode ("block" or "allow").
 * @returns {boolean} True if the value passes the filter, false otherwise.
 */
function filterList (value, list, mode) {
  const newList = (list || []).map((listItem) => String(listItem).toLowerCase());
  if (!newList.length) {
    return true;
  }
  const hit = newList.includes(String(value).toLowerCase());
  return mode === "block"
    ? !hit
    : hit;
}

/**
 * Filters a list of sessions based on the given configuration.
 * @param {Array} sessions The list of sessions to filter.
 * @param {Object} config The configuration object containing filter criteria.
 * @returns {Array} The filtered list of sessions.
 */
function filterSessions (sessions, config) {
  return sessions.filter((session) => {
    if (config.playbackLocation === "local" && session.isRemote) {
      return false;
    }
    if (config.playbackLocation === "remote" && !session.isRemote) {
      return false;
    }
    if (!filterList(session.kind, config.mediaTypes, config.mediaTypeFilterMode)) {
      return false;
    }
    if (!filterList(session.userName, config.users, config.userFilterMode)) {
      return false;
    }
    return true;
  });
}

/**
 * Builds avatar initials: first letter of the first and last word when the name
 * has a separator (space, -, _ or +), otherwise just the first letter.
 * @param {string} name The display name.
 * @returns {string} The upper-cased initials.
 */
function initials (name) {
  const words = String(name || "").split(/[\s\-_+]+/u)
    .filter(Boolean)
    .map((word) => Array.from(word)[0]);
  if (!words.length) {
    return "?";
  }
  return (words.length > 1
    ? words[0] + words[words.length - 1]
    : words[0]).toUpperCase();
}

/**
 * Applies a user map to the sessions, adding display names and initials.
 * @param {Array} sessions The list of sessions.
 * @param {Object} map The user map (userName -> displayName).
 * @returns {Array} The updated list of sessions with display names and initials.
 */
function applyUserMap (sessions, map = {}) {
  return sessions.map((session) => {
    const displayName = Object.hasOwn(map, session.userName) && map[session.userName] || session.userName;
    return {...session, displayName, initials: initials(displayName)};
  });
}

/**
 * Keeps recently-seen sessions and marks vanished ones as "stopped".
 */
class SessionTracker {
  constructor (stoppedSeconds = 10) {
    this.stoppedMs = stoppedSeconds * 1000; this.last = new Map();
    this.firstSeen = new Map(); this.counter = 0;
  }

  /**
   * Updates the tracker with the current sessions, marking vanished ones as "stopped" if they were seen recently.
   * @param {Array} current The current list of sessions.
   * @param {number} [now=Date.now()] The current timestamp.
   * @returns {Array} The updated list of sessions, including recently stopped ones.
   */
  update (current, now = Date.now()) {
    // eslint-disable-next-line id-length
    const ids = new Set(current.map((s) => s.id));
    // eslint-disable-next-line id-length
    const out = current.map((s) => ({...s}));
    for (const [id, prev] of this.last) {
      if (!ids.has(id)) {
        const since = prev.state === "stopped"
          ? prev.stoppedAt
          : now;
        if (now - since < this.stoppedMs) {
          out.push({...prev, state: "stopped", stoppedAt: since});
        }
      }
    }
    // eslint-disable-next-line id-length
    this.last = new Map(out.map((s) => [s.id, s]));
    return this.sortStable(out);
  }

  /**
   * Time until the earliest stopped session should be dropped.
   * @param {number} [now=Date.now()] The current timestamp.
   * @returns {number|null} Milliseconds until the next expiry, or null when none is pending.
   */
  nextExpiryMs (now = Date.now()) {
    const waits = [...this.last.values()]
      .filter((session) => session.state === "stopped")
      .map((session) => session.stoppedAt + this.stoppedMs - now);
    return waits.length
      ? Math.max(0, Math.min(...waits))
      : null;
  }

  /**
   * Playing first, then paused, then stopped; within a state, the order in which
   * sessions were first seen, so the Jellyfin response order cannot shuffle them.
   * @param {Array} sessions The list of sessions to sort.
   * @returns {Array} The sorted list of sessions.
   */
  sortStable (sessions) {
    const rank = {playing: 0, paused: 1, stopped: 2};
    for (const session of sessions) {
      if (!this.firstSeen.has(session.id)) {
        this.firstSeen.set(session.id, this.counter += 1);
      }
    }
    for (const id of this.firstSeen.keys()) {
      if (!this.last.has(id)) {
        this.firstSeen.delete(id);
      }
    }
    return sessions.sort((first, second) => (rank[first.state] ?? 1) - (rank[second.state] ?? 1) ||
      this.firstSeen.get(first.id) - this.firstSeen.get(second.id));
  }
}

module.exports = {isPrivateAddress, mediaKind: getMediaType, normalizeSession, filterSessions, SessionTracker, applyUserMap, initials};
