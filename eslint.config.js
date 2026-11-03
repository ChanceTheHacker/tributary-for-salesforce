const { defineConfig } = require('eslint/config');
const eslintJs = require('@eslint/js');
const jestPlugin = require('eslint-plugin-jest');
const lwcConfig = require('@salesforce/eslint-config-lwc/recommended');
const globals = require('globals');

module.exports = defineConfig([
    // LWC configuration
    {
        files: ['**/lwc/**/*.js'],
        extends: [lwcConfig],
        rules: {
            // Prettier decides when an arrow's conditional body gets parentheses.
            'no-confusing-arrow': 'off',
            // Code Analyzer's PMD can't parse a bare `catch {`, so unused
            // catch bindings are named `ignored`.
            'no-unused-vars': ['error', { vars: 'all', args: 'after-used', caughtErrorsIgnorePattern: '^ignored$' }]
        }
    },

    // LWC configuration with override for LWC test files
    {
        files: ['**/lwc/**/*.test.js'],
        extends: [lwcConfig],
        rules: {
            '@lwc/lwc/no-unexpected-wire-adapter-usages': 'off',
            // Tests wait for promises and re-renders with setTimeout.
            '@lwc/lwc/no-async-operation': 'off',
            'no-confusing-arrow': 'off'
        },
        languageOptions: {
            globals: {
                ...globals.node
            }
        }
    },

    // Jest mocks configuration
    {
        files: ['**/jest-mocks/**/*.js'],
        languageOptions: {
            sourceType: 'module',
            ecmaVersion: 'latest',
            globals: {
                ...globals.node,
                ...globals.es2021,
                ...jestPlugin.environments.globals.globals
            }
        },
        plugins: {
            eslintJs
        },
        extends: ['eslintJs/recommended']
    }
]);