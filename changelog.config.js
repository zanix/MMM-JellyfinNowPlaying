// Only the version in lib/client.js's PKG constant is touched, not the whole file.
const clientVersion = {
  readVersion: (contents) => (/version: "(?<version>[^"]+)"/u).exec(contents).groups.version,
  writeVersion: (contents, version) => contents.replace(/version: "[^"]+"/u, `version: "${version}"`)
};

module.exports = {
  packageFiles: ["package.json"],
  bumpFiles: [
    "package.json",
    "package-lock.json",
    {
      filename: "lib/client.js",
      updater: clientVersion
    }
  ],
  types: [
    {type: "feat", section: "Added"},
    {type: "fix", section: "Fixed"},
    {type: "perf", section: "Performance"},
    {type: "docs", section: "Documentation"},
    {type: "chore", section: "Chores"},
    {type: "refactor", section: "Refactoring"},
    {type: "test", section: "Tests"},
    {type: "build", section: "Build System"},
    {type: "ci", section: "Continuous Integration"}
  ]
};
