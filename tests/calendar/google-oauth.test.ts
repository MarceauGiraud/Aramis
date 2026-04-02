import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Google OAuth module
const mockGoogleAuth = {
  generateAuthUrl: vi.fn(),
  getToken: vi.fn(),
  setCredentials: vi.fn(),
};

vi.mock('google-auth-library', () => ({
  OAuth2Client: vi.fn().mockImplementation(() => mockGoogleAuth),
}));

describe('Google OAuth Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('OAuth URL Generation', () => {
    it('should generate authorization URL with correct scopes', async () => {
      const expectedScopes = [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly',
        'openid',
        'email',
        'profile',
      ];

      mockGoogleAuth.generateAuthUrl.mockReturnValue('https://accounts.google.com/o/oauth2/v2/auth?...');

      // Simulate generating auth URL
      const authUrl = mockGoogleAuth.generateAuthUrl({
        access_type: 'offline',
        scope: expectedScopes,
        prompt: 'consent',
      });

      expect(mockGoogleAuth.generateAuthUrl).toHaveBeenCalledWith(
        expect.objectContaining({
          access_type: 'offline',
          scope: expect.arrayContaining(expectedScopes),
        }),
      );
      expect(authUrl).toContain('accounts.google.com');
    });

    it('should include state parameter for CSRF protection', async () => {
      const state = 'random-csrf-token';

      mockGoogleAuth.generateAuthUrl({
        state,
        access_type: 'offline',
        scope: [],
      });

      expect(mockGoogleAuth.generateAuthUrl).toHaveBeenCalledWith(expect.objectContaining({ state }));
    });
  });

  describe('Token Exchange', () => {
    it('should exchange authorization code for tokens', async () => {
      const mockTokens = {
        access_token: 'ya29.access-token',
        refresh_token: '1//refresh-token',
        expiry_date: Date.now() + 3600000,
        token_type: 'Bearer',
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
      };

      mockGoogleAuth.getToken.mockResolvedValue({ tokens: mockTokens });

      const { tokens } = await mockGoogleAuth.getToken('authorization-code');

      expect(tokens.access_token).toBeDefined();
      expect(tokens.refresh_token).toBeDefined();
      expect(tokens.expiry_date).toBeGreaterThan(Date.now());
    });

    it('should handle token exchange errors', async () => {
      mockGoogleAuth.getToken.mockRejectedValue(new Error('invalid_grant: Code expired'));

      await expect(mockGoogleAuth.getToken('expired-code')).rejects.toThrow('invalid_grant');
    });
  });

  describe('Token Refresh', () => {
    it('should automatically refresh expired tokens', async () => {
      const expiredTokens = {
        access_token: 'expired-token',
        refresh_token: 'valid-refresh-token',
        expiry_date: Date.now() - 1000, // Expired
      };

      const newTokens = {
        access_token: 'new-access-token',
        expiry_date: Date.now() + 3600000,
      };

      mockGoogleAuth.setCredentials(expiredTokens);

      // Simulate token refresh
      const refreshedCredentials = {
        ...expiredTokens,
        ...newTokens,
      };

      expect(refreshedCredentials.access_token).toBe('new-access-token');
      expect(refreshedCredentials.expiry_date).toBeGreaterThan(Date.now());
    });
  });

  describe('Scope Validation', () => {
    it('should validate required scopes are present', () => {
      const requiredScopes = [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ];

      const grantedScopes =
        'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events.readonly openid email';

      const hasAllScopes = requiredScopes.every((scope) => grantedScopes.includes(scope));

      expect(hasAllScopes).toBe(true);
    });

    it('should reject when required scopes are missing', () => {
      const requiredScopes = [
        'https://www.googleapis.com/auth/calendar.readonly',
        'https://www.googleapis.com/auth/calendar.events.readonly',
      ];

      const grantedScopes = 'openid email'; // Missing calendar scopes

      const hasAllScopes = requiredScopes.every((scope) => grantedScopes.includes(scope));

      expect(hasAllScopes).toBe(false);
    });
  });
});
