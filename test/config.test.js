"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {validate: rawValidate} = require("../lib/config");
const {applyUserMap} = require("../lib/sessions");

// Load the real module defaults the same way MagicMirror hands them over.
let moduleDefinition;
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../MMM-JellyfinNowPlaying.js"), "utf8"), {
  Module: {register: (_name, definition) => {
    moduleDefinition = definition;
  }}
});
const DEFAULTS = JSON.parse(JSON.stringify(moduleDefinition.defaults));
const validate = (input) => rawValidate(input, DEFAULTS);

const withKey = (extra = {}) => ({...DEFAULTS, apiKey: "abc123", ...extra});

test("module defaults are valid when an api key is set", () => {
  const result = validate({...DEFAULTS, apiKey: "abc123"});
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.errors, []);
});

test("credentials: api key wins, otherwise username and password are required", () => {
  assert.equal(validate(withKey({username: "u", password: "p"})).config.username, "");
  assert.equal(validate(withKey({username: "u", password: "p"})).warnings.length, 1);
  assert.deepEqual(validate({...DEFAULTS}).errors.map((error) => error.code), ["NO_CREDENTIALS"]);
  assert.deepEqual(validate({...DEFAULTS, password: "p"}).errors.map((error) => error.code), ["NO_CREDENTIALS"]);
  const blank = validate({...DEFAULTS, username: "u"});
  assert.deepEqual(blank.errors, []);
  assert.equal(blank.warnings.length, 1);
  assert.equal(blank.config.username, "u");
  const ok = validate({...DEFAULTS, username: " u ", password: "p"});
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.config.username, "u");
  assert.equal(ok.config.apiKey, "");
});

test("api key with header-breaking characters is rejected", () => {
  for (const bad of ["a b", "a\"b", "a\r\nX: y", "a\\b"]) {
    assert.deepEqual(validate(withKey({apiKey: bad})).errors.map((error) => error.code), ["INVALID_CONFIG"], bad);
  }
});

test("serverUrl must be http(s) and is normalized", () => {
  assert.equal(validate(withKey({serverUrl: "https://user:pw@jf.example.com:8920/base/?a=1#x"})).config.serverUrl, "https://jf.example.com:8920/base");
  assert.equal(validate(withKey({serverUrl: "http://localhost:8096///"})).config.serverUrl, "http://localhost:8096");
  for (const bad of ["ftp://x", "data:text/html,x", "not a url", "", 5]) {
    assert.equal(validate(withKey({serverUrl: bad})).errors.length, 1, String(bad));
  }
});

test("enums, booleans and numbers fall back or clamp", () => {
  const {config, warnings} = validate(withKey({fontSize: "huge", playbackLocation: "REMOTE", useWebSocket: "yes", updateInterval: 1, stoppedDisplaySeconds: 1e9}));
  assert.equal(config.fontSize, "small");
  assert.equal(config.playbackLocation, "remote");
  assert.equal(config.useWebSocket, true);
  assert.equal(config.updateInterval, 5);
  assert.equal(config.stoppedDisplaySeconds, 3600);
  assert.equal(warnings.length, 4);
  assert.equal(validate(withKey({updateInterval: NaN})).config.updateInterval, DEFAULTS.updateInterval);
  assert.equal(validate(withKey({mediaTypeFilterMode: "block"})).config.mediaTypeFilterMode, "block");
});

test("style options are not checked and pass through", () => {
  const style = {accentColor: "red; background:url(x)", posterWidth: "9999px", titleFontSize: "calc(1em + 2px)"};
  const {config, warnings} = validate(withKey(style));
  assert.equal(config.accentColor, style.accentColor);
  assert.equal(config.posterWidth, style.posterWidth);
  assert.equal(config.titleFontSize, style.titleFontSize);
  assert.deepEqual(warnings, []);
});

test("lists and mapping are sanitized", () => {
  const {config, warnings} = validate(withKey({
    mediaTypes: ["Movie", "movie", "game", 5],
    users: [" alice ", "", "alice", {}, "bob"],
    userMapping: {alice: "<b>Al</b>", mappedKey: "x", bob: 5, "": "x"}
  }));
  assert.deepEqual(config.mediaTypes, ["movie"]);
  assert.deepEqual(config.users, ["alice", "bob"]);
  assert.deepEqual(config.userMapping, {alice: "bAl/b", mappedKey: "x"});
  assert.equal(warnings.length, 1);
  assert.deepEqual(validate(withKey({mediaTypes: "movie"})).config.mediaTypes, []);
});

test("header templates lose html and control characters", () => {
  const {config} = validate(withKey({headerTemplate: "<img src=x onerror=alert(1)>{play_count}\u0000"}));
  assert.equal(config.headerTemplate, "img src=x onerror=alert(1){play_count}");
});

test("non-object input yields defaults plus errors, never throws", () => {
  assert.equal(validate(null).errors.length, 2);
  assert.equal(validate("x").config.fontSize, "small");
});

test("userMapping ignores inherited keys", () => {
  const [session] = applyUserMap([{userName: "constructor"}], {});
  assert.equal(session.displayName, "constructor");
});

test("config.schema.json lists every default option with matching defaults", () => {
  const schema = JSON.parse(fs.readFileSync(path.join(__dirname, "../config.schema.json"), "utf8"));
  assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(DEFAULTS).sort());
  for (const [key, definition] of Object.entries(schema.properties)) {
    assert.deepEqual(definition.default, DEFAULTS[key], key);
  }
});
