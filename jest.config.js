module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/cdk/test', '<rootDir>/srv'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['@swc/jest']
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
