const { jestConfig } = require("@salesforce/sfdx-lwc-jest/config");

module.exports = {
  ...jestConfig,
  moduleNameMapper: {
    ...jestConfig.moduleNameMapper,
    "^fixtures/(.*)$": "<rootDir>/test/fixtures/$1",
    // CSS-only modules, which the LWC resolver doesn't look for.
    "^c/flowTokens$":
      "<rootDir>/force-app/main/default/lwc/flowTokens/flowTokens.css",
    "^c/flowBand$":
      "<rootDir>/force-app/main/default/lwc/flowBand/flowBand.css",
    "^lightning/modal$": "<rootDir>/test/jest-mocks/lightning/modal.js"
  },
  modulePathIgnorePatterns: ["<rootDir>/.localdevserver"]
};
