// jest.config.js
module.exports = {
  // Automatically clear mock calls and instances between every test
  clearMocks: true,

  // The directory where Jest should output its coverage files
  coverageDirectory: "coverage",

  // Indicates whether the coverage information should be collected while executing the test
  collectCoverage: true,

  // An array of glob patterns indicating a set of files for which coverage information should be collected
  // collectCoverageFrom: [
  //   "**/*.{js,jsx}",
  //   "!**/node_modules/**",
  //   "!**/vendor/**",
  //   "!jest.config.js",
  //   "!**/coverage/**"
  // ],

  // The test environment that will be used for testing
  testEnvironment: "node",

  // Module file extensions for importing
  moduleFileExtensions: ["js", "json", "jsx", "node"],
};
