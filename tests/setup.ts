import { beforeAll, afterAll, afterEach, vi } from 'vitest';

// Mock environment variables
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/aramis_test';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.S3_ENDPOINT = 'http://localhost:9000';
process.env.S3_ACCESS_KEY = 'minioadmin';
process.env.S3_SECRET_KEY = 'minioadmin';
process.env.S3_BUCKET = 'test-recordings';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars-long!';
process.env.NEXTAUTH_SECRET = 'test-secret';

// Global test setup
beforeAll(async () => {
  // Setup test database connection
  console.log('Setting up test environment...');
});

afterAll(async () => {
  // Cleanup
  console.log('Cleaning up test environment...');
});

afterEach(() => {
  // Reset mocks after each test
  vi.clearAllMocks();
});

// Mock fetch globally
global.fetch = vi.fn();

// Mock console.error to keep test output clean (optional)
// vi.spyOn(console, 'error').mockImplementation(() => {});
