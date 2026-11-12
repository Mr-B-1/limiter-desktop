import tseslint from 'typescript-eslint';
export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  { files: ['src/**/*.ts', 'tests/**/*.ts'], rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-eval': 'error',
    'no-implied-eval': 'error'
  } }
];
