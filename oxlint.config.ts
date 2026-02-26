import {defineConfig} from 'oxlint';

export default defineConfig({
  categories: {
    correctness: 'warn',
    style: 'error',
  },
  overrides: [
    {
      files: ['src/**/*.ts'],
      rules: {
        'func-style': 'off',
        'init-declarations': 'off',
        'max-statements': 'off',
        'no-magic-numbers': 'off', // Is there a better convention than something like process.exit(0); ?
        'no-ternary': 'off', // I like them, okay?
        'prefer-ternary': 'off', // Linter make up your mind omg
        'sort-imports': 'off',
      },
    },
  ],
  rules: {
    'unicorn/empty-brace-spaces': 'error',
    // I may add more later :)
  },
});
