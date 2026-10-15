"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const JellyfinClient = require("../lib/client");

// Mocks the Jellyfin SDK for testing purposes.
function fakeSdk ({sessions = [], failAuth = false} = {}) {
  return {
    Jellyfin: class {
      api = {update () { /* empty */ }};

      createApi () {
        return this.api;
      }
    },
    getSessionApi: () => ({getSessions: () => Promise.resolve({data: sessions})}),
    getAuthenticationApi: () => ({
      authenticateUserByName: () => {
        if (failAuth) {
          return Promise.reject(Object.assign(new Error("401"), {response: {status: 401}}));
        }
        return Promise.resolve({data: {AccessToken: "tok"}});
      }
    })
  };
}

// A sample session object returned by the Jellyfin API.
const raw = {Id: "s", UserName: "a", NowPlayingItem: {Id: "m", Type: "Movie", Name: "Film", ProductionYear: 1999}, PlayState: {}};

test("websocket url", () => {
  const client = new JellyfinClient({serverUrl: "https://jf.example.com", apiKey: "a b", deviceId: "d"}, {sdk: fakeSdk()});
  assert.equal(client.webSocketUrl(), "wss://jf.example.com/socket?deviceId=d");
});

test("getNowPlaying with API key returns normalized sessions", async () => {
  const client = new JellyfinClient({serverUrl: "http://x:8096/", apiKey: "k"}, {sdk: fakeSdk({sessions: [raw, {Id: "idle"}]})});
  const current = await client.getNowPlaying();
  assert.equal(current.length, 1);
  assert.equal(current[0].subtitle, "1999");
  assert.equal(client.baseUrl, "http://x:8096");
});

test("authenticates with credentials", async () => {
  const client = new JellyfinClient({serverUrl: "http://x", username: "u", password: "p"}, {sdk: fakeSdk()});
  await client.connect();
  assert.equal(client.token, "tok");
});

test("invalid credentials classified as AUTH", async () => {
  const client = new JellyfinClient({serverUrl: "http://x", username: "u", password: "bad"}, {sdk: fakeSdk({failAuth: true})});
  await assert.rejects(client.connect(), (error) => JellyfinClient.classifyError(error) === "AUTH");
});

test("missing credentials classified", async () => {
  const client = new JellyfinClient({serverUrl: "http://x"}, {sdk: fakeSdk()});
  await assert.rejects(client.connect(), (error) => JellyfinClient.classifyError(error) === "NO_CREDENTIALS");
});

test("network errors classified as NETWORK", () => {
  assert.equal(JellyfinClient.classifyError(new Error("ECONNREFUSED")), "NETWORK");
});

test("fetchImage sends auth header", async () => {
  let seen;
  const client = new JellyfinClient({serverUrl: "http://x", apiKey: "k"}, {sdk: fakeSdk(),
    /* eslint-disable id-length */
    fetch: (u, o) => {
      seen = {u, o};
      return Promise.resolve({ok: true});
    }});
    /* eslint-enable id-length */
  await client.fetchImage("/Items/abc/Images/Primary", 200);
  assert.match(seen.u, /maxWidth=200/u);
  assert.match(seen.o.headers.Authorization, /Token="k"/u);
});
