"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {normalizeSession, filterSessions, SessionTracker, isPrivateAddress, applyUserMap, initials} = require("../lib/sessions");

// Sample sessions for testing
const episode = {
  Id: "s1",
  UserId: "u1",
  UserName: "alice",
  DeviceName: "Living Room TV",
  Client: "Jellyfin Android TV",
  RemoteEndPoint: "192.168.1.20",
  PlayState: {PositionTicks: 600000000, IsPaused: false},
  NowPlayingItem: {Id: "e1", Type: "Episode", Name: "Pilot", SeriesName: "Show", SeriesId: "sr1", ParentIndexNumber: 1, IndexNumber: 3, RunTimeTicks: 12000000000}
};
const song = {
  Id: "s2",
  UserId: "u2",
  UserName: "bob",
  DeviceName: "iPhone",
  Client: "Swiftfin",
  RemoteEndPoint: "8.8.8.8",
  PlayState: {PositionTicks: 0, IsPaused: true},
  NowPlayingItem: {Id: "a1", Type: "Audio", Name: "Song", Artists: ["Artist"], Album: "Album", AlbumId: "al1", RunTimeTicks: 1800000000}
};
const movie = {
  Id: "s3",
  UserId: "u3",
  UserName: "carol",
  DeviceName: "Chrome",
  Client: "Jellyfin Web",
  RemoteEndPoint: "10.0.0.5",
  PlayState: {PositionTicks: 3000000000, IsPaused: false, PlayMethod: "Transcode"},
  NowPlayingItem: {Id: "m1", Type: "Movie", Name: "Film", ProductionYear: 1999, ImageTags: {Primary: "tag"}, RunTimeTicks: 60000000000}
};

test("ignores sessions without NowPlayingItem", () => assert.equal(normalizeSession({Id: "x"}), null));

test("normalizes an episode - playing, local", () => {
  const session = normalizeSession(episode);
  assert.equal(session.kind, "series");
  assert.equal(session.title, "Show");
  assert.equal(session.subtitle, "S1 • E3: Pilot");
  assert.equal(session.artist, "");
  assert.equal(session.album, "");
  assert.equal(session.state, "playing");
  assert.equal(session.transcoding, false);
  assert.equal(session.positionSeconds, 60);
  assert.equal(session.durationSeconds, 1200);
  assert.equal(session.isRemote, false);
  assert.equal(session.deviceKind, "tv");
  assert.equal(session.posterPath, "/Items/sr1/Images/Primary");
});

test("normalizes a movie - playing, local", () => {
  const session = normalizeSession(movie);
  assert.equal(session.kind, "movie");
  assert.equal(session.title, "Film");
  assert.equal(session.subtitle, "1999");
  assert.equal(session.artist, "");
  assert.equal(session.album, "");
  assert.equal(session.state, "playing");
  assert.equal(session.transcoding, true);
  assert.equal(session.positionSeconds, 300);
  assert.equal(session.durationSeconds, 6000);
  assert.equal(session.isRemote, false);
  assert.equal(session.deviceKind, "browser");
  assert.equal(session.posterPath, "/Items/m1/Images/Primary");
});

test("normalizes a song - paused, remote", () => {
  const session = normalizeSession(song);
  assert.equal(session.kind, "music");
  assert.equal(session.title, "Song");
  assert.equal(session.subtitle, "");
  assert.equal(session.artist, "Artist");
  assert.equal(session.album, "Album");
  assert.equal(session.state, "paused");
  assert.equal(session.transcoding, false);
  assert.equal(session.positionSeconds, 0);
  assert.equal(session.durationSeconds, 180);
  assert.equal(session.isRemote, true);
  assert.equal(session.deviceKind, "phone");
  assert.equal(session.posterPath, "/Items/al1/Images/Primary");
});

test("private address detection", () => {
  for (const addr of ["10.0.0.1", "172.16.5.5", "192.168.0.9", "127.0.0.1", "::1", "::ffff:192.168.1.2"]) {
    assert.equal(isPrivateAddress(addr), true, addr);
  }
  for (const addr of ["8.8.8.8", "172.32.0.1", "192.162.2.5", "2001:4860:4860::8888"]) {
    assert.equal(isPrivateAddress(addr), false, addr);
  }
});

test("filters by media type, user, location", () => {
  const all = [normalizeSession(episode), normalizeSession(song)];
  const base = {playbackLocation: "all", mediaTypes: [], users: [], mediaTypeFilterMode: "allow", userFilterMode: "allow"};
  assert.equal(filterSessions(all, base).length, 2);
  assert.deepEqual(filterSessions(all, {...base, mediaTypes: ["music"]}).map((session) => session.userName), ["bob"]);
  assert.deepEqual(filterSessions(all, {...base, mediaTypes: ["music"], mediaTypeFilterMode: "block"}).map((session) => session.userName), ["alice"]);
  assert.deepEqual(filterSessions(all, {...base, users: ["ALICE"]}).map((session) => session.userName), ["alice"]);
  assert.deepEqual(filterSessions(all, {...base, users: ["alice"], userFilterMode: "block"}).map((session) => session.userName), ["bob"]);
  assert.deepEqual(filterSessions(all, {...base, playbackLocation: "remote"}).map((session) => session.userName), ["bob"]);
  assert.deepEqual(filterSessions(all, {...base, playbackLocation: "local"}).map((session) => session.userName), ["alice"]);
});

test("user mapping", () => {
  const [mapping] = applyUserMap([normalizeSession(episode)], {alice: "Alice W."});
  assert.equal(mapping.displayName, "Alice W.");
});

test("initials use two letters with a separator, otherwise one", () => {
  assert.equal(initials("john smith"), "JS");
  assert.equal(initials("mary-jane_van+dyke"), "MD");
  assert.equal(initials("alice"), "A");
  assert.equal(initials(""), "?");
});

test("tracker orders playing, paused, stopped and keeps order stable", () => {
  const tracker = new SessionTracker(10);
  const make = (id, state) => ({id, state});
  tracker.update([make("a", "playing"), make("b", "playing"), make("c", "playing")], 0);
  const out = tracker.update([make("c", "playing"), make("b", "paused"), make("a", "playing")], 1000);
  assert.deepEqual(out.map((session) => session.id), ["a", "c", "b"]);
  const gone = tracker.update([make("c", "playing"), make("b", "paused")], 2000);
  assert.deepEqual(gone.map((session) => session.id), ["c", "b", "a"]);
});

test("tracker shows stopped sessions temporarily, with active sessions", () => {
  const tracker = new SessionTracker(10);
  const session = normalizeSession(episode);
  assert.equal(tracker.update([session], 0).length, 1);
  const current = tracker.update([], 1000);
  assert.equal(current.length, 1);
  assert.equal(current[0].state, "stopped");
  assert.equal(tracker.update([], 5000).length, 1);
  assert.equal(tracker.update([], 12000).length, 0);
});

test("tracker reports when the next stopped session expires", () => {
  const tracker = new SessionTracker(10);
  assert.equal(tracker.nextExpiryMs(0), null);
  tracker.update([{id: "a", state: "playing"}], 0);
  assert.equal(tracker.nextExpiryMs(0), null);
  tracker.update([], 1000);
  assert.equal(tracker.nextExpiryMs(4000), 7000);
  assert.equal(tracker.nextExpiryMs(20000), 0);
  assert.deepEqual(tracker.update([], 11000), []);
  assert.equal(tracker.nextExpiryMs(11000), null);
});
