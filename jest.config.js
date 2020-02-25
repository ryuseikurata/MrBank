const packageJson = require("./package.json");

module.exports = {
  name: packageJson.name,
  displayName: packageJson.name,
  rootDir: "./functions",
  preset: "ts-jest",
  testEnvironment: "node"
};
